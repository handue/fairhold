/**
 * One fresh read of a paddle for an autopilot run: the gate's facts and the decision's context
 * (docs/planning/glim-autopilot.md §3.4, §4). The guest's view of the auction comes from
 * loadGlimState, the same reads Glim's chat uses, with the engine's own commitments.
 */
import { z } from "zod";

import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import type { EventStatus } from "@/server/engine";
import type {
  AutopilotContext,
  AutopilotDecisionLot,
  AutopilotLimit,
  AutopilotRecentDecision,
  AutopilotTrigger,
  PendingRaise,
} from "@/server/glim/autopilot/types";
import type { AutopilotUsageSoFar } from "@/server/glim/caps";
import { parseMandate, type GlimMandate } from "@/server/glim/mandate";
import { isOpenForBids } from "@/server/glim/prompt";
import { loadGlimState } from "@/server/queries/glim-state";

import { PENDING_CARD_SECONDS, RAISE_PENDING_SECONDS } from "./apply";
import { RAISE_DISMISSED_KEY } from "./raise-offer";
import { autopilotUsage } from "./usage";

/** A lot autopilot dropped can't be added back by autopilot this soon (§3.5). */
export const RECENTLY_DROPPED_SECONDS = 120;
/** A Glim limit outbid in the action that created it marks its lot contested this long (§3.5). */
export const CONTESTED_SECONDS = 600;

export interface AutopilotRead {
  paddleId: string;
  eventId: string;
  isSimulated: boolean;
  eventStatus: EventStatus;
  plan: { id: string; status: string; version: number; mandate: GlimMandate | null } | null;
  holdCents: number | null;
  /** The latest unconfirmed plan card younger than two minutes, which suspends autopilot. */
  pendingCardAt: Date | null;
  appliedChanges: number;
  usage: AutopilotUsageSoFar;
  now: Date;
  /** Null unless the plan is active with a mandate. */
  context: AutopilotContext | null;
}

type HeadRow = {
  event_id: string;
  is_simulated: boolean;
  event_status: EventStatus;
  now: Date;
  plan_id: string | null;
  plan_status: string | null;
  version: number | null;
  mandate: unknown;
  hold_cents: number | null;
  pending_card_at: Date | null;
  applied_changes: number;
  raises_prepared: number;
};

const lotIdsSchema = z.array(z.object({ lotId: z.string() }).loose()).catch([]);
const intentSchema = z
  .array(z.object({ lotNumber: z.number().int(), priority: z.number().int(), maxCents: z.number().int().nullable() }))
  .catch([]);
const actionDetailSchema = z
  .object({
    before: lotIdsSchema.default([]),
    after: lotIdsSchema.default([]),
    pendingIntent: intentSchema.default([]),
  })
  .loose()
  .catch({ before: [], after: [], pendingIntent: [] });

export async function loadAutopilotRead(
  paddleId: string,
  triggers: readonly AutopilotTrigger[],
  database: DatabaseClient = getDatabaseClient(),
): Promise<AutopilotRead | null> {
  const { pool } = database;
  const head = await pool.query<HeadRow>(
    `select p.event_id, p.is_simulated, e.status as event_status, now() as now,
       pl.id as plan_id, pl.status as plan_status, pl.version, pl.mandate,
       (select h.amount_cents from holds h where h.paddle_id = p.id and h.status = 'authorized') as hold_cents,
       (select max(g.created_at) from glim_plans g
         where g.paddle_id = p.id and g.status = 'proposed' and g.created_at > now() - make_interval(secs => $2)) as pending_card_at,
       (select count(*)::int from glim_actions a where a.paddle_id = p.id and a.kind = 'autopilot_changed') as applied_changes,
       (select count(*)::int from glim_actions a where a.paddle_id = p.id and a.kind = 'autopilot_raise_prepared') as raises_prepared
     from paddles p
     join events e on e.id = p.event_id
     left join glim_plans pl on pl.paddle_id = p.id and pl.status in ('active', 'paused')
     where p.id = $1`,
    [paddleId, PENDING_CARD_SECONDS],
  );
  const row = head.rows[0];
  if (!row) return null;
  const mandate = parseMandate(row.mandate);
  const read: AutopilotRead = {
    paddleId,
    eventId: row.event_id,
    isSimulated: row.is_simulated,
    eventStatus: row.event_status,
    plan: row.plan_id === null ? null : { id: row.plan_id, status: row.plan_status ?? "", version: row.version ?? 1, mandate },
    holdCents: row.hold_cents,
    pendingCardAt: row.pending_card_at,
    appliedChanges: row.applied_changes,
    usage: await autopilotUsage(pool, paddleId, row.event_id, row.now),
    now: row.now,
    context: null,
  };
  if (row.plan_id === null || row.plan_status !== "active" || !mandate) return read;

  const state = await loadGlimState({ paddleId }, database);
  if (!state) return read;

  const items = await pool.query<{ id: string; lot_id: string; lot_number: number; priority: number; max_cents: number }>(
    `select i.id, i.lot_id, l.number as lot_number, i.priority, i.max_cents
     from glim_plan_items i join lots l on l.id = i.lot_id
     where i.plan_id = $1 order by i.priority, l.number`,
    [row.plan_id],
  );
  const limits = await pool.query<{
    id: string;
    lot_id: string;
    lot_number: number;
    owner: AutopilotLimit["owner"];
    max_cents: number;
    active: boolean;
    created_at: Date;
    contested: boolean;
  }>(
    `select bl.id, bl.lot_id, l.number as lot_number, bl.owner, bl.max_cents, bl.active, bl.created_at,
       (bl.owner = 'glim' and bl.exhausted_at = bl.created_at) as contested
     from bid_limits bl join lots l on l.id = bl.lot_id
     where bl.paddle_id = $1
       and (bl.active
         or (bl.owner = 'guest_max' and bl.created_at >= $2)
         or (bl.owner = 'glim' and bl.exhausted_at = bl.created_at and bl.created_at > now() - make_interval(secs => $3)))`,
    [paddleId, mandate.confirmedAt, CONTESTED_SECONDS],
  );
  const actions = await pool.query<{
    id: string;
    kind: AutopilotRecentDecision["kind"];
    plan_id: string | null;
    message: string;
    amount_cents: number | null;
    created_at: Date;
    detail: unknown;
  }>(
    `select id, kind, plan_id, message, amount_cents, created_at, detail from glim_actions
     where paddle_id = $1 and kind in ('autopilot_changed', 'autopilot_raise_prepared')
     order by created_at desc, id desc limit 10`,
    [paddleId],
  );

  const recentDecisions: AutopilotRecentDecision[] = actions.rows
    .map((action) => {
      const detail = actionDetailSchema.parse(action.detail);
      return {
        actionId: action.id,
        at: action.created_at,
        kind: action.kind,
        message: action.message,
        beforeLotIds: detail.before.map((lot) => lot.lotId),
        afterLotIds: detail.after.map((lot) => lot.lotId),
      };
    })
    .reverse();
  const droppedSince = row.now.getTime() - RECENTLY_DROPPED_SECONDS * 1000;
  const recentlyDroppedLotIds = [
    ...new Set(
      recentDecisions
        .filter((decision) => decision.kind === "autopilot_changed" && decision.at.getTime() > droppedSince)
        .flatMap((decision) => decision.beforeLotIds.filter((lotId) => !decision.afterLotIds.includes(lotId))),
    ),
  ];

  const active = limits.rows.filter((limit) => limit.active);
  const cutoff = Date.parse(mandate.confirmedAt);
  const context: AutopilotContext = {
    state,
    plan: {
      id: row.plan_id,
      version: row.version ?? 1,
      status: "active",
      items: items.rows.map((item) => ({
        id: item.id,
        lotId: item.lot_id,
        lotNumber: item.lot_number,
        priority: item.priority,
        maxCents: item.max_cents,
      })),
    },
    mandate,
    limits: active.map((limit) => ({
      id: limit.id,
      lotId: limit.lot_id,
      lotNumber: limit.lot_number,
      owner: limit.owner,
      maxCents: limit.max_cents,
      createdAt: limit.created_at,
    })),
    guestControlledLotIds: [
      ...new Set(
        limits.rows
          .filter((limit) => limit.owner === "guest_max" && (limit.active || limit.created_at.getTime() >= cutoff))
          .map((limit) => limit.lot_id),
      ),
    ],
    contestedLotIds: [...new Set(limits.rows.filter((limit) => limit.contested).map((limit) => limit.lot_id))],
    recentlyDroppedLotIds,
    recentDecisions,
    pendingRaise: pendingRaise(actions.rows[0], row.plan_id, state, row.now),
    raisesPrepared: row.raises_prepared,
    triggers: [...triggers],
  };
  return { ...read, context };
}

/**
 * The raise waiting for the guest's approval (§6.4): the newest autopilot action, if it is a
 * prepared raise for the running plan, younger than ten minutes, above the hold in place, with all
 * its lots still open, that the guest hasn't dismissed with "Not now". A newer applied decision ends
 * it, and so does a plan edit (Update plan supersedes the plan it was for) or a hold that already
 * reached its amount.
 */
function pendingRaise(
  latest: { id: string; kind: string; plan_id: string | null; amount_cents: number | null; created_at: Date; detail: unknown } | undefined,
  planId: string,
  state: NonNullable<Awaited<ReturnType<typeof loadGlimState>>>,
  now: Date,
): PendingRaise | null {
  if (!latest || latest.kind !== "autopilot_raise_prepared" || latest.amount_cents === null) return null;
  if (latest.plan_id !== planId) return null;
  if (now.getTime() - latest.created_at.getTime() > RAISE_PENDING_SECONDS * 1000) return null;
  // The guest's "Not now" ends it: a raise approved later on 09 is not consent to this move.
  if (typeof latest.detail === "object" && latest.detail !== null && RAISE_DISMISSED_KEY in latest.detail) return null;
  const lots: AutopilotDecisionLot[] = actionDetailSchema.parse(latest.detail).pendingIntent;
  const open = lots.every((lot) => {
    const found = state.lots.find((candidate) => candidate.number === lot.lotNumber);
    return found !== undefined && isOpenForBids(found, state.now);
  });
  if (!open || lots.length === 0) return null;
  return {
    actionId: latest.id,
    amountCents: latest.amount_cents,
    createdAt: latest.created_at,
    approved: state.holdCents !== null && state.holdCents >= latest.amount_cents,
    lots,
  };
}
