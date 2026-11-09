/**
 * Glim's event cards: what the engine did for a paddle, as a deterministic sentence with exact
 * amounts. The wording is approved on 07 and 10 ("Someone bid $360. I raised to $380, your limit for
 * this lot."), and the live bidding never waits on the model. Pure: event-card-sync.ts reads the facts
 * from the paddle's channel and writes what this returns.
 */
import type {
  LimitExhaustedPayload,
  LimitRaisedPayload,
  LotLostPayload,
  LotWonPayload,
} from "@/server/engine/events";
import { formatUsd } from "@/server/glim/money";
import { timeFormatter } from "@/server/glim/prompt";
import type { GlimActionKind } from "@/server/glim/types";

import type { EventCard, EventCardChip } from "./types";

export type EventFactPayload = LimitRaisedPayload | LimitExhaustedPayload | LotWonPayload | LotLostPayload;

/** One event_log row on a paddle's channel that may become a card. */
export interface EventFact {
  id: string;
  payload: EventFactPayload;
  createdAt: Date;
}

export interface EventCardDraft {
  action: {
    kind: GlimActionKind;
    lotId: string;
    amountCents: number | null;
    limitCents: number | null;
    /** The rival's amount this answered or stopped at, for glim_actions.trigger_bid_id. */
    triggerAmountCents: number | null;
    chip: "winning" | "closed" | "none";
    message: string;
  };
  card: Omit<EventCard, "actionId">;
}

function raisedLine(payload: LimitRaisedPayload): string {
  if (payload.opening) return `I bid ${formatUsd(payload.amountCents)} for you. I’ll go up to ${formatUsd(payload.limitCents)}.`;
  const rival = payload.triggerAmountCents === null ? "Someone outbid you" : `Someone bid ${formatUsd(payload.triggerAmountCents)}`;
  const atLimit = payload.amountCents === payload.limitCents;
  return `${rival}. I raised to ${formatUsd(payload.amountCents)}${atLimit ? ", your limit for this lot." : "."}`;
}

function lostLine(payload: LotLostPayload): string {
  const closed = payload.winningCents === null ? "Bidding closed." : `Bidding closed at ${formatUsd(payload.winningCents)}.`;
  return `${closed} You didn’t win, so you won’t be charged.`;
}

/** The card a fact becomes, or null for a fact Glim says nothing about (a guest's own max, say). */
export function eventCardDraft(fact: EventFact, context: { timezone: string; shortTitle: string }): EventCardDraft | null {
  const { payload } = fact;
  const base = { lotId: payload.lotId };
  let action: EventCardDraft["action"];
  let chip: EventCardChip | null;
  switch (payload.kind) {
    case "limit_raised":
      if (payload.owner !== "glim") return null;
      chip = payload.leading ? { kind: "winning", amountCents: payload.amountCents } : null;
      action = {
        ...base,
        kind: payload.opening ? "bid" : "raise",
        amountCents: payload.amountCents,
        limitCents: payload.limitCents,
        triggerAmountCents: payload.triggerAmountCents,
        chip: payload.leading ? "winning" : "none",
        message: raisedLine(payload),
      };
      break;
    case "limit_exhausted":
      if (payload.owner !== "glim") return null;
      chip = null;
      action = {
        ...base,
        kind: "limit_reached",
        amountCents: payload.currentBidCents,
        limitCents: payload.limitCents,
        triggerAmountCents: payload.currentBidCents,
        chip: "none",
        message: `Someone bid ${formatUsd(payload.currentBidCents)}, over your ${formatUsd(payload.limitCents)} limit.`,
      };
      break;
    case "lot_won":
      chip = { kind: "closed" };
      action = {
        ...base,
        kind: "lot_won",
        amountCents: payload.amountCents,
        limitCents: null,
        triggerAmountCents: null,
        chip: "closed",
        message: `Bidding closed. You won at ${formatUsd(payload.amountCents)}.`,
      };
      break;
    case "lot_lost":
      chip = { kind: "closed" };
      action = {
        ...base,
        kind: "lot_lost",
        amountCents: payload.winningCents,
        limitCents: null,
        triggerAmountCents: null,
        chip: "closed",
        message: lostLine(payload),
      };
      break;
    default:
      return null;
  }
  return {
    action,
    card: {
      type: "event",
      at: fact.createdAt.toISOString(),
      eyebrow: eventEyebrow(fact.createdAt, context.timezone, context.shortTitle),
      line: action.message,
      chip,
    },
  };
}

/** "9:14 PM · CHEF’S TABLE". */
export function eventEyebrow(at: Date, timezone: string, label: string): string {
  return `${timeFormatter(timezone, false)(at)} · ${label.toLocaleUpperCase("en-US")}`;
}

/** An autopilot_finished row: which limits its run created, and the transaction that created them. */
export interface AutopilotAnnouncement {
  limitIds: readonly string[];
  /** event_log.created_at as Postgres prints it: every row of one transaction has the same value. */
  transaction: string;
}

/**
 * True for a fact the autopilot's own card already tells (docs/planning/glim-autopilot.md §6.2): the
 * opening bid of a limit its run created, and that limit being outbid in the very same transaction
 * ("but another bidder's limit there is higher"). Later bids on the limit get their cards as usual.
 */
export function announcedByAutopilot(fact: EventFact & { transaction: string }, announcements: readonly AutopilotAnnouncement[]): boolean {
  const { payload } = fact;
  if (payload.kind !== "limit_raised" && payload.kind !== "limit_exhausted") return false;
  return announcements.some(
    (announcement) =>
      announcement.limitIds.includes(payload.limitId) &&
      ((payload.kind === "limit_raised" && payload.opening) || announcement.transaction === fact.transaction),
  );
}
