import type { EventLogEntry, EventLogType } from "@/server/sse/notify";

import type { BidSource, Cents, LimitOwner } from "./types";

/*
 * Payloads of the event_log rows the engine writes, keyed by `kind`. Public rows (paddle_id null)
 * carry what every viewer of the event may see; paddle rows go only to that paddle's channel.
 * Amounts are cents. Glim's cards and the activity feeds are templates over these facts.
 */

type LotRef = { lotId: string; lotNumber: number };

type LimitRef = LotRef & { limitId: string; owner: LimitOwner; planItemId: string | null };

/** Public: every bid an action placed on one lot, in order, and where the lot ended up. */
export type BidsPlacedPayload = LotRef & {
  kind: "bids_placed";
  bids: { bidId: string; paddleId: string; paddleNumber: number; amountCents: Cents; source: BidSource }[];
  currentBidCents: Cents;
  bidCount: number;
  highPaddleId: string;
  highPaddleNumber: number;
  nextMinimumCents: Cents;
};

/** Paddle: it was leading (or bid) on the lot during the action and no longer leads. */
export type OutbidPayload = LotRef & {
  kind: "outbid";
  yourBidCents: Cents;
  currentBidCents: Cents;
  nextMinimumCents: Cents;
};

/** Paddle: a guest max or Glim limit was created, replacing `replacedLimitId` if set. */
export type LimitSetPayload = LimitRef & {
  kind: "limit_set";
  maxCents: Cents;
  replacedLimitId: string | null;
};

/** Paddle: a limit bid for the paddle. "Someone bid $360. I raised to $380, your limit." */
export type LimitRaisedPayload = LimitRef & {
  kind: "limit_raised";
  /** The limit's last bid in this action. */
  amountCents: Cents;
  limitCents: Cents;
  /** The current bid the last raise answered; null when it was the lot's first bid. */
  triggerAmountCents: Cents | null;
  raises: number;
  /** The limit was created by this same action (an opening bid of a new max or plan). */
  opening: boolean;
  leading: boolean;
};

/** Paddle: the lot's next minimum passed the limit's max while someone else leads. */
export type LimitExhaustedPayload = LimitRef & {
  kind: "limit_exhausted";
  limitCents: Cents;
  currentBidCents: Cents;
};

/** Paddle: a limit should have answered a bid but its paddle's hold did not allow it. */
export type LimitBlockedPayload = LimitRef & {
  kind: "limit_blocked";
  reason: "no_hold" | "over_bidding_power";
  amountCents: Cents;
};

export type LimitRemovedPayload = LimitRef & { kind: "limit_removed" };

export type LimitsPausedPayload = {
  kind: "limits_paused" | "limits_resumed";
  owner: LimitOwner;
  limitIds: string[];
  lotIds: string[];
};

/** Public: the lot closed with its winner fixed. */
export type LotClosedPayload = LotRef & {
  kind: "lot_closed";
  winningPaddleId: string | null;
  winningPaddleNumber: number | null;
  winningCents: Cents | null;
  bidCount: number;
};

export type LotWonPayload = LotRef & { kind: "lot_won"; amountCents: Cents };

/** Paddle: it bid on or held a limit on the lot and someone else won it. */
export type LotLostPayload = LotRef & { kind: "lot_lost"; winningCents: Cents | null };

/** Public: every lot is closed, so the event moved from live to closed. */
export type EventClosedPayload = { kind: "event_closed"; status: "closed" };

export type EnginePayload =
  | BidsPlacedPayload
  | OutbidPayload
  | LimitSetPayload
  | LimitRaisedPayload
  | LimitExhaustedPayload
  | LimitBlockedPayload
  | LimitRemovedPayload
  | LimitsPausedPayload
  | LotClosedPayload
  | LotWonPayload
  | LotLostPayload
  | EventClosedPayload;

export type EngineEvent = {
  eventId: string;
  paddleId: string | null;
  payload: EnginePayload;
};

/** Glim-owned limits report on the paddle's "glim" stream; guest maxes are ordinary bid news. */
export function eventLogType(payload: EnginePayload): EventLogType {
  switch (payload.kind) {
    case "bids_placed":
    case "outbid":
      return "bid";
    case "lot_closed":
    case "lot_won":
    case "lot_lost":
      return "lot_closed";
    case "event_closed":
      return "event_status";
    default:
      return payload.owner === "glim" ? "glim" : "bid";
  }
}

export function toEventLogEntry(event: EngineEvent): EventLogEntry {
  return {
    eventId: event.eventId,
    paddleId: event.paddleId,
    type: eventLogType(event.payload),
    payload: event.payload,
  };
}
