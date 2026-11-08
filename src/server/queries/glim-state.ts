/**
 * Glim's view of one paddle (GlimState, src/server/glim/types.ts), read from Postgres. Lots and
 * the guest's relation to them come from the same reads the guest pages use; the hold and every
 * commitment come from the engine's own calculation (getBiddingPower, getCommitments), so the
 * allocator plans within exactly the room placeBid will allow, never a copy of the rule.
 */
import { sql } from "drizzle-orm";

import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { getBiddingPower, getCommitments, nextMinimumCents, type LotCommitment } from "@/server/engine";
import { parseMandate } from "@/server/glim/mandate";
import type {
  GlimCommitment,
  GlimLotState,
  GlimPlanState,
  GlimRecentDecision,
  GlimState,
  PlanItemStatus,
  PlanStatus,
} from "@/server/glim/types";

import { createPostgresGuestSource } from "./postgres-source";
import type { LotRecord, ViewerLotRecord } from "./types";
import { indexViewerLots, viewerLotStatus } from "./viewer";

export interface GlimStateQuery {
  paddleId: string;
  /** Set when the chat was opened from a lot page ("Let Glim bid on this lot"). */
  openedFromLotNumber?: number | null;
  /** Defaults to the database clock; a frozen clock reproduces a fixture moment. */
  now?: Date;
}

type PaddleRow = {
  paddle_id: string;
  paddle_number: number;
  first_name: string;
  event_id: string;
  timezone: string;
  hold_presets_cents: number[];
  hold_min_cents: number | null;
  hold_max_cents: number | null;
};

type PlanRow = { id: string; status: PlanStatus; budget_cents: number; mandate: unknown };
type PlanItemRow = { lot_number: number; priority: number; max_cents: number; status: PlanItemStatus };

/** Null when the paddle does not exist. */
export async function loadGlimState(
  query: GlimStateQuery,
  { db, pool }: DatabaseClient = getDatabaseClient(),
): Promise<GlimState | null> {
  const { rows } = await db.execute<PaddleRow>(sql`
    select p.id::text as paddle_id, p.number as paddle_number, p.first_name, e.id::text as event_id,
      e.timezone, e.hold_presets_cents, e.hold_min_cents, e.hold_max_cents
    from paddles p
    join events e on e.id = p.event_id
    where p.id = ${query.paddleId}
  `);
  const paddle = rows[0];
  if (!paddle) return null;

  const reads = createPostgresGuestSource(db);
  const [now, lots, viewerLots, power, commitments, plan, recentDecisions] = await Promise.all([
    query.now ?? reads.currentTime().then((instant) => new Date(instant)),
    reads.listLots(paddle.event_id),
    reads.listViewerLots(paddle.event_id, paddle.paddle_id),
    getBiddingPower([paddle.paddle_id], pool),
    getCommitments([paddle.paddle_id], pool),
    loadPlan(db, paddle.paddle_id),
    loadRecentDecisions(db, paddle.paddle_id),
  ]);

  const relations = indexViewerLots(viewerLots);
  const presets = [...paddle.hold_presets_cents].sort((a, b) => a - b);
  const lotNumberById = new Map(lots.map((lot) => [lot.id, lot.number]));
  const hold = power.get(paddle.paddle_id);

  return {
    now,
    event: {
      id: paddle.event_id,
      timezone: paddle.timezone,
      holdPresetsCents: presets,
      // Events from the template always set both; the presets bound an event that does not.
      holdMinCents: paddle.hold_min_cents ?? presets[0] ?? 0,
      holdMaxCents: paddle.hold_max_cents ?? presets.at(-1) ?? 0,
    },
    guest: { paddleId: paddle.paddle_id, paddleNumber: paddle.paddle_number, firstName: paddle.first_name },
    holdCents: hold?.holdId ? hold.holdCents : null,
    lots: lots
      .filter((lot) => lot.status === "open" || (lot.status === "closed" && relations.get(lot.id)?.hasBid))
      .map((lot) => glimLot(lot, paddle.paddle_id, relations.get(lot.id))),
    commitments: commitments.flatMap((row) => {
      const lotNumber = lotNumberById.get(row.lotId);
      return lotNumber === undefined || row.cents === 0 ? [] : [glimCommitment(row, lotNumber)];
    }),
    plan,
    favoriteLotNumbers: viewerLots
      .filter((relation) => relation.isFavorite)
      .flatMap((relation) => lotNumberById.get(relation.lotId) ?? [])
      .sort((a, b) => a - b),
    openedFromLotNumber: query.openedFromLotNumber ?? null,
    recentDecisions,
  };
}

type DecisionRow = { at_ms: number; message: string; detail: unknown };

/** Glim's last three autopilot decisions, oldest first, with every amount their sentences show. */
async function loadRecentDecisions(db: DatabaseClient["db"], paddleId: string): Promise<GlimRecentDecision[]> {
  const { rows } = await db.execute<DecisionRow>(sql`
    select (extract(epoch from created_at) * 1000)::float8 as at_ms, message, detail
    from glim_actions
    where paddle_id = ${paddleId} and kind in ('autopilot_changed', 'autopilot_raise_prepared')
    order by created_at desc, id desc
    limit 3
  `);
  return rows
    .map((row) => {
      const amounts = (row.detail as { amountsCents?: unknown } | null)?.amountsCents;
      return {
        at: new Date(row.at_ms),
        message: row.message,
        amountsCents: Array.isArray(amounts) ? amounts.filter((value): value is number => Number.isSafeInteger(value)) : [],
      };
    })
    .reverse();
}

function glimLot(lot: LotRecord, paddleId: string, relation: ViewerLotRecord | undefined): GlimLotState {
  return {
    id: lot.id,
    number: lot.number,
    shortTitle: lot.shortTitle,
    category: lot.category,
    status: lot.status,
    closesAt: new Date(lot.closesAt),
    currentBidCents: lot.currentBidCents,
    bidCount: lot.bidCount,
    nextMinimumCents: nextMinimumCents(lot),
    minRaiseCents: lot.minRaiseCents,
    guestStatus: viewerLotStatus(lot, paddleId, relation),
  };
}

/**
 * The engine's commitment on one lot, labeled for Glim. withoutGlimCents is what the lot would
 * still commit if Glim's limit were removed: the leading bid, which stands either way.
 */
export function glimCommitment(row: LotCommitment, lotNumber: number): GlimCommitment {
  const base = { lotNumber, cents: row.cents };
  if (row.wonCents > 0) return { ...base, source: "won", withoutGlimCents: row.cents };
  const limitCounts = row.limitOwner !== null && (row.limitCents ?? 0) >= row.leadingCents;
  if (limitCounts && row.limitOwner === "glim") {
    return { ...base, source: "glim_limit", withoutGlimCents: row.leadingCents };
  }
  if (limitCounts) return { ...base, source: "guest_max", withoutGlimCents: row.cents };
  return { ...base, source: "winning_bid", withoutGlimCents: row.cents };
}

/** The running plan (active or paused), else the latest proposal; ended and superseded ones never. */
async function loadPlan(db: DatabaseClient["db"], paddleId: string): Promise<GlimPlanState | null> {
  const { rows } = await db.execute<PlanRow>(sql`
    select id::text as id, status, budget_cents, mandate
    from glim_plans
    where paddle_id = ${paddleId} and status in ('proposed', 'active', 'paused')
    order by (status <> 'proposed') desc, created_at desc, version desc
    limit 1
  `);
  const plan = rows[0];
  if (!plan) return null;

  const items = await db.execute<PlanItemRow>(sql`
    select l.number as lot_number, i.priority, i.max_cents, i.status
    from glim_plan_items i
    join lots l on l.id = i.lot_id
    where i.plan_id = ${plan.id}
    order by i.priority, l.number
  `);
  // Read exactly as confirmPlan reads it, so a change card states the B confirming it would keep.
  const mandate = parseMandate(plan.mandate);
  return {
    id: plan.id,
    status: plan.status,
    budgetCents: plan.budget_cents,
    mandate: mandate === null ? null : { budgetCents: mandate.budgetCents },
    items: items.rows.map((item) => ({
      lotNumber: item.lot_number,
      priority: item.priority,
      maxCents: item.max_cents,
      status: item.status,
    })),
  };
}
