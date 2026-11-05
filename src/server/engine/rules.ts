import type { Refusal } from "./refusals";
import type { Cents, EventStatus, LotState, LotStatus } from "./types";

const ENDED_EVENT_STATUSES: ReadonlySet<EventStatus> = new Set(["closed", "settling", "settled"]);

/** Closed, settling or settled: bidding is over for the whole event. */
export function eventHasEnded(status: EventStatus): boolean {
  return ENDED_EVENT_STATUSES.has(status);
}

type MinimumInput = Pick<LotState, "highPaddleId" | "currentBidCents" | "startingBidCents" | "minRaiseCents">;

/** The smallest acceptable bid: the starting bid on a lot without bids, else current plus the minimum raise. */
export function nextMinimumCents(lot: MinimumInput): Cents {
  if (lot.highPaddleId === null || lot.currentBidCents === null) return lot.startingBidCents;
  return lot.currentBidCents + lot.minRaiseCents;
}

/**
 * The lowest max a new limit may have: the lot's next minimum, or the paddle's own bid when it
 * already leads. That bid stands either way, and the limit answers once outbid only if its max
 * allows, so a plan change can keep a lot that is already at its limit. Glim's allocator offers
 * exactly this floor (minimumMaxCents in src/server/glim/allocator.ts).
 */
export function minimumLimitCents(lot: MinimumInput, paddleId: string): Cents {
  if (lot.highPaddleId === paddleId && lot.currentBidCents !== null) return lot.currentBidCents;
  return nextMinimumCents(lot);
}

/**
 * Null when the lot takes bids right now, otherwise the refusal. A lot whose closes_at has passed
 * refuses bids even while its status still says open, so bidding never depends on the tick.
 */
export function biddingGate(lot: LotState): Refusal | null {
  if (lot.status === "closed" || eventHasEnded(lot.eventStatus)) {
    return { reason: "lot_closed", lotId: lot.id, closesAt: lot.closesAt, closedAt: lot.closedAt };
  }
  if (lot.status !== "open" || lot.eventStatus !== "live") {
    return { reason: "not_open", lotId: lot.id, lotStatus: lot.status, eventStatus: lot.eventStatus };
  }
  if (lot.pastClose) {
    return { reason: "lot_closed", lotId: lot.id, closesAt: lot.closesAt, closedAt: lot.closedAt };
  }
  return null;
}

export interface CommitmentInput {
  status: LotStatus;
  highPaddleId: string | null;
  currentBidCents: Cents | null;
  winningPaddleId: string | null;
  winningCents: Cents | null;
}

/**
 * What a paddle has committed on one lot. On a closed lot it is the amount the paddle won.
 * Otherwise it is the paddle's active limit at its max or its leading bid, whichever is larger;
 * the two differ only after a guest bids by hand above their own limit, and then the leading bid
 * is what they would pay.
 *
 * The invariant: for every paddle, the sum over its lots never exceeds its authorized hold.
 * The SQL version of this rule is COMMITMENTS_SQL in bidding-power.ts; keep the two identical.
 */
export function commitmentCents(
  lot: CommitmentInput,
  paddleId: string,
  activeLimitMaxCents: Cents | null,
): Cents {
  if (lot.status === "closed") {
    return lot.winningPaddleId === paddleId ? (lot.winningCents ?? 0) : 0;
  }
  const leadingCents = lot.highPaddleId === paddleId ? (lot.currentBidCents ?? 0) : 0;
  return Math.max(activeLimitMaxCents ?? 0, leadingCents);
}
