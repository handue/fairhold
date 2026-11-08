/**
 * The rivals who make the story happen. Each reads the guest's situation when it runs, so an edited
 * plan, a paused one or a lot that has moved on just means the rival has nothing to do.
 */
import { getBiddingPower, nextMinimumCents } from "@/server/engine";
import { parseMandate } from "@/server/glim/mandate";

import { lockLot, lotUnavailable, placeDirectorBid, skipped, type JobResult, type LockedLot } from "./bids";
import type { RivalOfPlanPayload, RivalOutbidPayload } from "./jobs";
import { chooseRival, destinationLotNumbers, directorCeilingCents, overLimitAllowed, type RivalCandidate } from "./rules";
import type { JobContext } from "./run";

interface PlanTarget {
  mandate: unknown;
  lotId: string;
  limitCents: number | null;
}

/** The guest's running plan and its priority-1 lot, with Glim's limit there if it still has one. */
async function priorityOneTarget(context: JobContext, guestPaddleId: string): Promise<PlanTarget | null> {
  const { rows } = await context.client.query<{ mandate: unknown; lot_id: string; max_cents: number | null }>(
    `select p.mandate, i.lot_id, bl.max_cents
     from glim_plans p
     join glim_plan_items i on i.plan_id = p.id and i.status <> 'skipped'
     left join bid_limits bl on bl.paddle_id = p.paddle_id and bl.lot_id = i.lot_id
       and bl.owner = 'glim' and bl.active and bl.paused_at is null
     where p.paddle_id = $1 and p.status = 'active'
     order by i.priority
     limit 1`,
    [guestPaddleId],
  );
  const row = rows[0];
  return row ? { mandate: row.mandate, lotId: row.lot_id, limitCents: row.max_cents } : null;
}

async function rivalCandidates(context: JobContext): Promise<RivalCandidate[]> {
  const { rows } = await context.client.query<{ id: string; number: number; bot_profile: { targets?: RivalCandidate["targets"] } | null }>(
    "select id, number, bot_profile from paddles where event_id = $1 and is_simulated",
    [context.job.eventId],
  );
  const power = await getBiddingPower(rows.map((row) => row.id), context.client);
  return rows.map((row) => ({
    id: row.id,
    number: row.number,
    availableCents: power.get(row.id)?.availableCents ?? 0,
    targets: row.bot_profile?.targets ?? [],
  }));
}

async function rivalBid(context: JobContext, lot: LockedLot, amountCents: number): Promise<JobResult> {
  if (amountCents > directorCeilingCents(lot.number)) return skipped("over_ceiling");
  const rival = chooseRival(await rivalCandidates(context), {
    lotNumber: lot.number,
    amountCents,
    leadingPaddleId: lot.highPaddleId,
  });
  return rival ? placeDirectorBid(context, rival.id, lot, amountCents) : skipped("no_rival_with_room");
}

/** A rival bids Glim's priority-1 lot to one raise under the limit, which Glim answers at its limit. */
export async function runRivalUnderLimit(context: JobContext, { guestPaddleId }: RivalOfPlanPayload): Promise<JobResult> {
  const target = await priorityOneTarget(context, guestPaddleId);
  if (!target) return skipped("no_running_plan");
  if (target.limitCents === null) return skipped("no_limit_on_lot");
  const lot = await lockLot(context.client, target.lotId);
  if (!lot) return skipped("lot_closed");
  const unavailable = lotUnavailable(lot, context.now);
  if (unavailable) return skipped(unavailable);

  const amountCents = target.limitCents - lot.minRaiseCents;
  if (amountCents < nextMinimumCents(lot)) return skipped("no_room_under_limit");
  return rivalBid(context, lot, amountCents);
}

/**
 * A rival passes Glim's limit on its priority-1 lot, which wakes Glim's autopilot: $400 over a $380
 * limit on Chef's Table in the golden take. It fires only while Glim has somewhere to move the money.
 */
export async function runRivalOverLimit(context: JobContext, { guestPaddleId }: RivalOfPlanPayload): Promise<JobResult> {
  const target = await priorityOneTarget(context, guestPaddleId);
  if (!target) return skipped("no_running_plan");
  if (target.limitCents === null) return skipped("no_limit_on_lot");

  const { rows: destinations } = await context.client.query<{ status: string; closes_at: Date }>(
    "select status, closes_at from lots where event_id = $1 and number = any($2)",
    [context.job.eventId, destinationLotNumbers(parseMandate(target.mandate)?.lots)],
  );
  const allowed = overLimitAllowed(
    destinations.map((lot) => ({ status: lot.status, closesAt: lot.closes_at })),
    context.now,
  );
  if (!allowed) return skipped("destination_closing");

  const lot = await lockLot(context.client, target.lotId);
  if (!lot) return skipped("lot_closed");
  const unavailable = lotUnavailable(lot, context.now);
  if (unavailable) return skipped(unavailable);
  return rivalBid(context, lot, Math.max(nextMinimumCents(lot), target.limitCents + lot.minRaiseCents));
}

/**
 * A rival outbids the guest on their second manual lot. A guest's own "Max…" would answer a plain
 * next-minimum bid and the guest would never see the lot flip, so the rival goes past it. Glim's
 * limits are left to answer as usual: passing one belongs to runRivalOverLimit.
 */
export async function runRivalOutbid(context: JobContext, { guestPaddleId, lotId }: RivalOutbidPayload): Promise<JobResult> {
  const lot = await lockLot(context.client, lotId);
  if (!lot) return skipped("lot_closed");
  const unavailable = lotUnavailable(lot, context.now);
  if (unavailable) return skipped(unavailable);
  if (lot.highPaddleId !== guestPaddleId) return skipped("guest_not_leading");

  const { rows } = await context.client.query<{ max_cents: number }>(
    "select max_cents from bid_limits where paddle_id = $1 and lot_id = $2 and active and owner = 'guest_max'",
    [guestPaddleId, lotId],
  );
  const guestMaxCents = rows[0]?.max_cents ?? 0;
  const amountCents = Math.max(nextMinimumCents(lot), guestMaxCents === 0 ? 0 : guestMaxCents + lot.minRaiseCents);
  return rivalBid(context, lot, amountCents);
}
