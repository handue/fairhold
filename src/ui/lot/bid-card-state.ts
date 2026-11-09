/**
 * 05's bid card as decisions, with no React in them (design/19). The card draws whatever these say;
 * tests/unit/ui/bid-card-state.test.ts walks every state the board draws.
 *
 * Bidding power here follows the engine's rule exactly (commitmentCents, the invariant placeBid
 * enforces), not the nav's display rule, so the card never offers a bid the engine would refuse for
 * want of bidding power, and its figures match the refusal's when one still happens.
 */
import { commitmentCents } from "@/server/engine/rules";
import { ApiClientError } from "@/ui/api";
import type { EventStatus, LotDetail, LotRecord, PaddleRecord, ViewerLotRecord } from "@/server/queries/types";

// ---------------------------------------------------------------------------------------------
// Bidding power on one lot

export interface PowerOnLot {
  /** The authorized hold, or null when bidding power is not set. */
  holdCents: number | null;
  /** The hold less what is committed on every other lot: the most this lot can take. Never below 0. */
  availableCents: number;
  /** The paddle's active limit on this lot ("Max…" or Glim's), which a new bid here still counts. */
  limitHereCents: number | null;
}

export interface PowerRecords {
  lots: readonly LotRecord[];
  paddle: PaddleRecord | null;
  viewerLots: readonly ViewerLotRecord[];
}

/** What the paddle can still commit on `lotId`, by the engine's commitment rule. */
export function powerOnLot({ lots, paddle, viewerLots }: PowerRecords, lotId: string): PowerOnLot {
  const limits = new Map(viewerLots.map((relation) => [relation.lotId, relation.limitCents]));
  const limitHereCents = limits.get(lotId) ?? null;
  if (!paddle || paddle.holdCents === null) return { holdCents: null, availableCents: 0, limitHereCents };

  const elsewhereCents = lots
    .filter((lot) => lot.id !== lotId)
    .reduce((sum, lot) => sum + commitmentCents(lot, paddle.id, limits.get(lot.id) ?? null), 0);
  return {
    holdCents: paddle.holdCents,
    availableCents: Math.max(0, paddle.holdCents - elsewhereCents),
    limitHereCents,
  };
}

/** What a bid of `amountCents` commits on the lot: the engine counts the larger of it and a limit there. */
export function bidNeedsCents(power: PowerOnLot, amountCents: number): number {
  return Math.max(power.limitHereCents ?? 0, amountCents);
}

/**
 * The new total to hold that covers `neededCents` on this lot, in whole dollars: what "Raise
 * bidding power" asks 09 for. Null without a hold, where 09 sets one instead of raising it.
 */
export function raiseToCoverCents(power: PowerOnLot, neededCents: number): number | null {
  if (power.holdCents === null) return null;
  const shortfallCents = Math.max(0, neededCents - power.availableCents);
  return Math.ceil((power.holdCents + shortfallCents) / 100) * 100;
}

// ---------------------------------------------------------------------------------------------
// Which card

export type BidCardPhase =
  /** Bidding hasn't started: no presets, the time it opens (state 7). */
  | "opens_soon"
  | "open"
  /** Closed and the viewer won it (state 9). */
  | "won"
  /** Closed and sold to another paddle (state 8). */
  | "sold"
  /** Closed with no bids. Undrawn: state 8's card with nothing sold. */
  | "unsold";

type PhaseLot = Pick<LotDetail, "status" | "viewerStatus" | "currentBidCents">;

export function bidCardPhase(lot: PhaseLot, eventStatus: EventStatus): BidCardPhase {
  if (lot.status === "closed") {
    if (lot.viewerStatus === "won") return "won";
    return lot.currentBidCents === null ? "unsold" : "sold";
  }
  if (lot.status !== "open" || eventStatus === "draft" || eventStatus === "scheduled") return "opens_soon";
  return "open";
}

/** "Starting bid" until someone bids, "Final bid" once a sold lot closes. */
export function priceLabel(phase: BidCardPhase, currentBidCents: number | null): string {
  if (currentBidCents === null) return "Starting bid";
  return phase === "won" || phase === "sold" ? "Final bid" : "Current bid";
}

/** The presets' label: the first bid is "Your bid"; after that, "Raise to". */
export function presetsLabel(currentBidCents: number | null): string {
  return currentBidCents === null ? "Your bid" : "Raise to";
}

/** The line under the lock, which says what holds the bids in each state. */
export function trustLine(phase: BidCardPhase, action: BidAction["kind"] | null, eventStatus: EventStatus): string {
  if (phase === "won") {
    return eventStatus === "settled" ? "The rest of your hold was released." : "The rest of your hold is released at the same time.";
  }
  if (phase === "sold" || phase === "unsold") return "You’re only charged for lots you win.";
  if (phase === "opens_soon" || action === "set_power") return "Bids are held with PayPal. You’re only charged if you win.";
  if (action === "raise") return "You’ll approve another hold in a PayPal window.";
  return "Held with PayPal. You’re only charged if you win.";
}

/** The won lot's payment line: at the close while bidding runs, then once the organizer charges. */
export function wonPaymentLine(eventStatus: EventStatus, closesLabel: string): string {
  switch (eventStatus) {
    case "settled":
      return "Paid with PayPal";
    case "closed":
    case "settling":
      return "You’ll pay with PayPal shortly";
    default:
      return `You’ll pay with PayPal at ${closesLabel}`;
  }
}

/** 08's shorter form of the same line, under a won tile's price. */
export function wonTileLine(eventStatus: EventStatus, closesLabel: string): string {
  switch (eventStatus) {
    case "settled":
      return "Paid";
    case "closed":
    case "settling":
      return "You’ll pay shortly";
    default:
      return `You’ll pay at ${closesLabel}`;
  }
}

/**
 * The paddle that bought a closed lot: the newest bid in its history, which holds the final amount
 * because amounts strictly rise. Null when the history doesn't reach it.
 */
export function soldToPaddleNumber(
  lot: Pick<LotDetail, "status" | "currentBidCents">,
  history: readonly { paddleNumber: number; amountCents: number }[],
): number | null {
  const newest = history[0];
  if (lot.status !== "closed" || lot.currentBidCents === null || !newest) return null;
  return newest.amountCents === lot.currentBidCents ? newest.paddleNumber : null;
}

// ---------------------------------------------------------------------------------------------
// What the button does on an open lot

/** A refusal the server sent back for the card's last try, with the numbers it carries. */
export type CardRefusal =
  | { kind: "no_hold" }
  | { kind: "over_bidding_power"; requiredCents: number; availableCents: number; holdCents: number }
  | { kind: "message"; message: string };

/** What a failed bid or max leaves on the card: a state when the board draws one, else the server's sentence. */
export function refusalOf(failure: unknown): CardRefusal {
  if (!(failure instanceof ApiClientError)) return { kind: "message", message: "Something went wrong. Please try again." };
  if (failure.code === "no_hold") return { kind: "no_hold" };
  const details = failure.details as Partial<Record<"requiredCents" | "availableCents" | "holdCents", unknown>> | null;
  if (
    failure.code === "over_bidding_power" &&
    typeof details?.requiredCents === "number" &&
    typeof details.availableCents === "number" &&
    typeof details.holdCents === "number"
  ) {
    return {
      kind: "over_bidding_power",
      requiredCents: details.requiredCents,
      availableCents: details.availableCents,
      holdCents: details.holdCents,
    };
  }
  return { kind: "message", message: failure.message };
}

export type BidAction =
  /** No hold yet: the button goes to 09 (state 6). */
  | { kind: "set_power" }
  /** More than is left: the notice and the way to 09's raise (state 3). */
  | {
      kind: "raise";
      subject: "bid" | "max";
      neededCents: number;
      availableCents: number;
      holdCents: number;
      raiseToCents: number | null;
    }
  /** Place bid, or Bid again when outbid (states 1, 4, 5). */
  | { kind: "place"; amountCents: number; label: "Place bid" | "Bid again" }
  /** Max… opened (state 2). `maxCents` is null until a whole-dollar amount is typed. */
  | { kind: "set_max"; maxCents: number | null; minimumCents: number; tooLow: boolean };

export interface BidActionInput {
  lot: Pick<LotDetail, "viewerStatus" | "currentBidCents" | "nextMinimumCents">;
  power: PowerOnLot;
  /** The preset on screen; ignored while Max… is open. */
  amountCents: number;
  /** Max… is open; `maxCents` is what is typed, or null. */
  max: { maxCents: number | null } | null;
  refusal: CardRefusal | null;
}

/** The lowest max the engine takes: the paddle's own leading bid, or the next minimum (minimumLimitCents). */
export function lowestMaxCents(lot: BidActionInput["lot"]): number {
  return lot.viewerStatus === "winning" && lot.currentBidCents !== null ? lot.currentBidCents : lot.nextMinimumCents;
}

export function bidAction({ lot, power, amountCents, max, refusal }: BidActionInput): BidAction {
  const subject = max ? "max" : "bid";
  if (power.holdCents === null || refusal?.kind === "no_hold") return { kind: "set_power" };

  if (refusal?.kind === "over_bidding_power") {
    return {
      kind: "raise",
      subject,
      neededCents: refusal.requiredCents,
      availableCents: refusal.availableCents,
      holdCents: refusal.holdCents,
      raiseToCents: raiseToCoverCents(
        { ...power, holdCents: refusal.holdCents, availableCents: refusal.availableCents },
        refusal.requiredCents,
      ),
    };
  }

  // A max under the minimum is refused whatever the bidding power, so a raise wouldn't help.
  const minimumCents = lowestMaxCents(lot);
  if (max && max.maxCents !== null && max.maxCents < minimumCents) {
    return { kind: "set_max", maxCents: max.maxCents, minimumCents, tooLow: true };
  }

  const committing = max ? max.maxCents : amountCents;
  if (committing !== null) {
    const neededCents = max ? committing : bidNeedsCents(power, committing);
    if (neededCents > power.availableCents) {
      return {
        kind: "raise",
        subject,
        neededCents,
        availableCents: power.availableCents,
        holdCents: power.holdCents,
        raiseToCents: raiseToCoverCents(power, neededCents),
      };
    }
  }

  if (max) return { kind: "set_max", maxCents: max.maxCents, minimumCents, tooLow: false };
  return { kind: "place", amountCents, label: lot.viewerStatus === "outbid" ? "Bid again" : "Place bid" };
}

/** Max…'s field holds digits only, shown as "$1,200"; this is what it shows for what was typed. */
export function maxFieldText(digits: string): string {
  return digits === "" ? "" : `$${Number(digits).toLocaleString("en-US")}`;
}

/** Keeps the digits of what was typed, without leading zeros, at most seven (under $10 million). */
export function maxFieldDigits(typed: string): string {
  return typed.replace(/\D/g, "").replace(/^0+/, "").slice(0, 7);
}
