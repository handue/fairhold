/**
 * The words of 11 and 25b that depend on the figures, written once so the page and the PDF agree.
 * design/25 draws them; the plural and single forms follow its sentences.
 */
import type { ReceiptGlimView, ReceiptLot, ReceiptPhase, ReceiptView } from "@/server/queries/receipt-view";

import { formatClockTime, formatClosedTime, formatUsd } from "../format";
import { keepLastWords } from "../paddle/text";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

/** "the 2 lots you won", "the lot you won". */
function lotsYouWon(count: number): string {
  return count === 1 ? "the lot you won" : `the ${count} lots you won`;
}

/** Glim's row: what it placed, and how that ended. Null when Glim placed no bids (25 drops the row). */
export function glimSay(glim: ReceiptGlimView | null, wonAnything: boolean): [string, string | null] | null {
  if (!glim) return null;
  const { bidsPlaced, allWithinLimits, singleLimitCents, planLots, planLotsWon } = glim;
  const placed = `I placed ${bidsPlaced} ${plural(bidsPlaced, "bid", "bids")} for you`;
  let first: string;
  if (!allWithinLimits) first = `${placed}.`;
  else if (singleLimitCents !== null) first = `${placed}, within your ${formatUsd(singleLimitCents)} limit.`;
  else first = bidsPlaced === 1 ? `${placed}, within your limit.` : `${placed}, each within your limits.`;

  let second: string | null = null;
  if (planLots > 0 && planLotsWon === planLots) {
    second = planLots === 1 ? "You won the lot in your plan." : planLots === 2 ? "You won both lots in your plan." : `You won all ${planLots} lots in your plan.`;
  } else if (planLots > 0 && planLotsWon > 0) {
    second = `You won ${planLotsWon} of the ${planLots} lots in your plan.`;
  } else if (planLots > 0) {
    const past =
      planLots > 1
        ? "Other bidders went past your limits"
        : singleLimitCents !== null && allWithinLimits
          ? "Another bidder went past it"
          : "Another bidder went past your limit";
    second = wonAnything ? `${past}.` : `${past}, so you weren’t charged.`;
  }
  return [first, second];
}

/** "Bid by Glim · at your $380 limit", "Bid by Glim · $30 under your $120 limit", "Your last bid · $90". */
export function bidByLine(lot: ReceiptLot, won: boolean): { glim: boolean; parts: Array<string | { cents: number }> } | null {
  const amount = won ? lot.paidCents : lot.lastBidCents;
  if (lot.bidBy === "glim" && lot.limitCents !== null && amount !== null) {
    const under = lot.limitCents - amount;
    return {
      glim: true,
      parts:
        under > 0
          ? ["Bid by Glim · ", { cents: under }, " under your ", { cents: lot.limitCents }, " limit"]
          : ["Bid by Glim · at your ", { cents: lot.limitCents }, " limit"],
    };
  }
  if (lot.bidBy === "glim") return { glim: true, parts: ["Bid by Glim"] };
  if (!won && lot.lastBidCents !== null) return { glim: false, parts: ["Your last bid · ", { cents: lot.lastBidCents }] };
  if (won && lot.bidBy === "guest") return { glim: false, parts: ["Bid by you"] };
  return null;
}

/** The same line in running text, for the PDF's table: "Bid by Glim, at your $380 limit". */
export function bidByText(lot: ReceiptLot): string | null {
  const line = bidByLine(lot, true);
  if (!line) return null;
  return line.parts
    .map((part) => (typeof part === "string" ? part : formatUsd(part.cents)))
    .join("")
    .replace(" · ", ", ");
}

/** The two lines under the bar. */
export function captionLines(
  view: Pick<ReceiptView, "phase" | "won" | "releaseCents" | "receipt" | "releasedAt" | "event"> & Partial<Pick<ReceiptView, "hold">>,
): [string, string] {
  const tz = view.event.timeZone;
  const count = view.won.length;
  switch (view.phase) {
    case "paid": {
      const at = view.receipt ? ` at ${formatClockTime(view.receipt.issuedAt, tz)}` : "";
      return [
        `One payment${at} for ${lotsYouWon(count)}.`,
        view.releaseCents > 0 ? "The rest of your hold was released at the same time." : "Nothing was left to release.",
      ];
    }
    case "pending":
      return [
        `One payment for ${lotsYouWon(count)}, when the organizer charges.`,
        view.releaseCents > 0 ? "The rest of your hold is released at the same time." : "Nothing is left to release.",
      ];
    case "released": {
      // A guest who joined but never set bidding power (not drawn): there was no hold to release.
      if (view.hold === null) return ["You won no lots, so you were never charged.", "You didn’t set bidding power, so nothing was held."];
      const at = view.releasedAt ?? view.event.closesAt;
      return ["You won no lots, so you were never charged.", `Your whole hold was released at ${formatClockTime(at, tz)}.`];
    }
    case "release_pending":
      if (view.hold === null) return ["You won no lots, so you won’t be charged.", "You didn’t set bidding power, so nothing is held."];
      return ["You won no lots, so you won’t be charged.", "Your whole hold is released when the organizer charges."];
  }
}

/** The receipt's first-line label. */
export function receiptTitle(phase: ReceiptPhase, number: string | null): string {
  if (phase === "paid" && number) return `Receipt ${number}`;
  if (phase === "pending") return "Receipt pending";
  return phase === "released" ? "Hold released" : "Hold releasing";
}

/** Glim's corner bubble on 11. */
export function receiptBubble(phase: ReceiptPhase, pickupNote: string | null): { title: string; body: string } | null {
  switch (phase) {
    case "paid":
      return pickupNote ? { title: "Your items are ready", body: keepLastWords(pickupNote) } : null;
    case "pending":
      return { title: "Almost there", body: "Your receipt appears when winners are charged." };
    case "released":
      return { title: "Nothing to pick up", body: "Your hold is already released." };
    case "release_pending":
      return { title: "Nothing to pick up", body: "Your hold is released when winners are charged." };
  }
}

/** C5: the charity's details are labeled as placeholders on a sandbox receipt. */
export function charityLines(event: Pick<ReceiptView["event"], "charityName" | "charityEin" | "charityIs501c3">): [string, string | null] {
  const first = `${event.charityName} is a made-up charity for this demo.`;
  const details = [event.charityIs501c3 ? "501(c)(3) status" : null, event.charityEin ? `EIN ${event.charityEin}` : null].filter(
    (detail): detail is string => detail !== null,
  );
  if (details.length === 0) return [first, null];
  return [first, `Its ${details.join(" and ")} ${details.length === 1 ? "is a placeholder" : "are placeholders"}.`];
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** "Sat, November 7, 2026 · 9:30 PM" (11), or with the weekday in full (25b). */
export function receiptDate(at: number, timeZone: string, weekday: "short" | "long"): string {
  const key = `${timeZone}|${weekday}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, weekday, month: "long", day: "numeric", year: "numeric" });
    dateFormatters.set(key, formatter);
  }
  return `${formatter.format(at)} · ${formatClosedTime(at, timeZone)}`;
}

/** The file name a browser saves 25b as (Chrome takes it from the page title while it prints). */
export function receiptFileName(number: string): string {
  return `fairhold-sandbox-receipt-${number}`;
}
