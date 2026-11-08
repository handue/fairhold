/**
 * The one way the director bids. Everything it places goes through here and then through the
 * engine's placeBid with source "bot", so a director bid passes the same checks as a guest's: the
 * lot must be open by the database clock, the amount at least the next minimum, and the hold must
 * cover it. Only simulated guests can bid here, and none of this reaches PayPal.
 */
import { placeBid, type RefusalReason } from "@/server/engine";
import type { EventStatus, LotStatus } from "@/server/engine/types";

import { directorCeilingCents, LOT_END_MARGIN_MS } from "./rules";

import type { JobContext } from "./run";

export type SkipReason =
  | "lot_closed"
  | "already_leading"
  | "past_max"
  | "stale"
  | "over_ceiling"
  | "not_simulated"
  | "no_running_plan"
  | "no_limit_on_lot"
  | "no_room_under_limit"
  | "destination_closing"
  | "guest_not_leading"
  | "no_rival_with_room";

/** What a job did, kept on its row for anyone checking what the director did and why. */
export type JobResult =
  | { outcome: "bid"; paddleNumber: number; lotNumber: number; amountCents: number; answeredWithCents: number[] }
  | { outcome: "skipped"; reason: SkipReason }
  | { outcome: "refused"; reason: RefusalReason };

export const skipped = (reason: SkipReason): JobResult => ({ outcome: "skipped", reason });

export interface LockedLot {
  id: string;
  eventId: string;
  number: number;
  status: LotStatus;
  eventStatus: EventStatus;
  startingBidCents: number;
  minRaiseCents: number;
  currentBidCents: number | null;
  highPaddleId: string | null;
  closesAt: Date;
}

type LotRow = {
  id: string;
  event_id: string;
  number: number;
  status: LotStatus;
  event_status: EventStatus;
  starting_bid_cents: number;
  min_raise_cents: number;
  current_bid_cents: number | null;
  high_paddle_id: string | null;
  closes_at: Date;
};

/**
 * The lot under its row lock, the first lock in the engine's order, kept until the job commits. The
 * bid a job works out from this therefore still holds when placeBid checks it.
 */
export async function lockLot(client: JobContext["client"], lotId: string): Promise<LockedLot | null> {
  const { rows } = await client.query<LotRow>(
    `select l.id, l.event_id, l.number, l.status, e.status as event_status, l.starting_bid_cents, l.min_raise_cents,
       l.current_bid_cents, l.high_paddle_id, l.closes_at
     from lots l join events e on e.id = l.event_id
     where l.id = $1
     for update of l`,
    [lotId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    eventId: row.event_id,
    number: row.number,
    status: row.status,
    eventStatus: row.event_status,
    startingBidCents: row.starting_bid_cents,
    minRaiseCents: row.min_raise_cents,
    currentBidCents: row.current_bid_cents,
    highPaddleId: row.high_paddle_id,
    closesAt: row.closes_at,
  };
}

/** "lot_closed" when the director should leave this lot alone at `now`, else null. */
export function lotUnavailable(lot: LockedLot, now: Date): "lot_closed" | null {
  if (lot.status !== "open" || lot.eventStatus !== "live") return "lot_closed";
  return lot.closesAt.getTime() - now.getTime() < LOT_END_MARGIN_MS ? "lot_closed" : null;
}

export async function placeDirectorBid(
  context: JobContext,
  paddleId: string,
  lot: LockedLot,
  amountCents: number,
): Promise<JobResult> {
  if (amountCents > directorCeilingCents(lot.number)) return skipped("over_ceiling");

  const { rows } = await context.client.query<{ number: number; is_simulated: boolean }>(
    "select number, is_simulated from paddles where id = $1",
    [paddleId],
  );
  const paddle = rows[0];
  if (!paddle?.is_simulated) return skipped("not_simulated");

  const placed = await placeBid(paddleId, lot.id, amountCents, "bot", { store: context.store });
  if (!placed.ok) return { outcome: "refused", reason: placed.refusal.reason };
  return {
    outcome: "bid",
    paddleNumber: paddle.number,
    lotNumber: lot.number,
    amountCents: placed.bid.amountCents,
    answeredWithCents: placed.proxyBids.map((bid) => bid.amountCents),
  };
}
