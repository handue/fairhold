/**
 * The guest's Pause and Resume (docs/planning/glim-autopilot.md §5.2). The plan's status and version
 * move first, in their own transaction: that is what fences an autopilot decision in flight, which
 * re-reads both under the plan row lock. Only then do Glim's limits stop or start, through the engine.
 * pauseLimits takes no paddle lock and reads the lots to pause before locking them, so a limit the
 * autopilot committed just before the fence is seen, and none can appear after it.
 *
 * Both are safe to repeat: when the plan is already in the asked state nothing is recorded again, and
 * the engine's call still runs, which finishes a pause or a resume interrupted between the two steps.
 */
import type pg from "pg";

import { getPool } from "@/server/db/client";
import { pauseLimits, resumeLimits, type PlacedBid } from "@/server/engine";
import { PAUSED_LINE, planLine, resumedLine } from "@/server/glim/copy";
import { appendEventLog } from "@/server/sse/notify";

import { PlanAbort, withPlanTransaction } from "./db";

interface PlanFence {
  planId: string;
  version: number;
  eventId: string;
  /** False when the plan was already in the asked state. */
  changed: boolean;
  /** The glim_actions row this step wrote; null when it changed nothing. */
  actionId: string | null;
  /** The sentence on that row. */
  message: string | null;
}

export type PausePlanResult = ({ ok: true; limitIds: string[] } & PlanFence) | { ok: false; reason: "no_plan" };
export type ResumePlanResult = ({ ok: true; limitIds: string[]; bids: PlacedBid[] } & PlanFence) | { ok: false; reason: "no_plan" };

/** Moves the running plan to `status` and records it, or says nothing changed. */
async function fencePlan(pool: pg.Pool, paddleId: string, status: "paused" | "resumed"): Promise<PlanFence | null> {
  const next = status === "paused" ? "paused" : "active";
  return withPlanTransaction<PlanFence | null>(pool, async ({ client }) => {
    const { rows } = await client.query<{ id: string; status: string; version: number; event_id: string }>(
      `select g.id, g.status, g.version, p.event_id
       from glim_plans g join paddles p on p.id = g.paddle_id
       where g.paddle_id = $1 and g.status in ('active', 'paused')
       for update of g`,
      [paddleId],
    );
    const plan = rows[0];
    if (!plan) throw new PlanAbort<PlanFence | null>(null);
    if (plan.status === next) {
      return { planId: plan.id, version: plan.version, eventId: plan.event_id, changed: false, actionId: null, message: null };
    }
    const moved = await client.query<{ version: number }>(
      `update glim_plans set status = $2::glim_plan_status, version = version + 1,
         paused_at = case when $2::glim_plan_status = 'paused' then now() else null end
       where id = $1 returning version`,
      [plan.id, next],
    );
    const version = moved.rows[0]?.version ?? plan.version + 1;
    const message = status === "paused" ? PAUSED_LINE : resumedLine(planLine(await planLots(client, plan.id)));
    const action = await client.query<{ id: string }>(
      `insert into glim_actions (paddle_id, plan_id, kind, hold_cents_at_time, decision, message, chip)
       values ($1, $2, $3, (select amount_cents from holds where paddle_id = $1 and status = 'authorized'), 'executed', $4, 'none')
       returning id`,
      [paddleId, plan.id, status, message],
    );
    // The last write before commit: the event_log ordering lock is held from here on.
    await appendEventLog(client, [
      { eventId: plan.event_id, paddleId, type: "glim", payload: { kind: "plan_status", planId: plan.id, status: next, version } },
    ]);
    return { planId: plan.id, version, eventId: plan.event_id, changed: true, actionId: action.rows[0]?.id ?? null, message };
  });
}

async function planLots(
  client: Pick<pg.ClientBase, "query">,
  planId: string,
): Promise<{ shortTitle: string; maxCents: number }[]> {
  const { rows } = await client.query<{ short_title: string; max_cents: number }>(
    `select l.short_title, i.max_cents
     from glim_plan_items i join lots l on l.id = i.lot_id
     where i.plan_id = $1 and i.status <> 'skipped' and l.status = 'open'
     order by i.priority, l.number`,
    [planId],
  );
  return rows.map((row) => ({ shortTitle: row.short_title, maxCents: row.max_cents }));
}

/** No new Glim bids; existing bids stand, and the limits keep their share of the hold. */
export async function pausePlan(input: { paddleId: string; pool?: pg.Pool }): Promise<PausePlanResult> {
  const pool = input.pool ?? getPool();
  const fence = await fencePlan(pool, input.paddleId, "paused");
  if (!fence) return { ok: false, reason: "no_plan" };
  const { limitIds } = await pauseLimits(input.paddleId, { owner: "glim", pool });
  return { ok: true, ...fence, limitIds };
}

/** Glim's limits bid again, starting with any bid they missed while paused. */
export async function resumePlan(input: { paddleId: string; pool?: pg.Pool }): Promise<ResumePlanResult> {
  const pool = input.pool ?? getPool();
  const fence = await fencePlan(pool, input.paddleId, "resumed");
  if (!fence) return { ok: false, reason: "no_plan" };
  const { limitIds, bids } = await resumeLimits(input.paddleId, { owner: "glim", pool });
  return { ok: true, ...fence, limitIds, bids };
}
