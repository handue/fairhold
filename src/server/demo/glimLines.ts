/**
 * The sentences seeded Glim actions carry, in the approved wording of 07 and 10 ("Someone bid
 * $360. I raised to $380, your limit for this lot."). Live actions get theirs from Glim's own
 * templates; these only have to match the screens the fixture reproduces.
 */
import type { GlimChip } from "./plan";
import type { GlimActionKind } from "./replay";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatUsd(cents: number): string {
  return usd.format(cents / 100);
}

export interface GlimLineInput {
  kind: GlimActionKind;
  amountCents: number | null;
  limitCents: number | null;
  /** The rival bid a raise answered. */
  triggerCents: number | null;
  /** The plan's items, for plan_started. */
  planItems: readonly { shortTitle: string; maxCents: number }[];
}

export function glimLine({ kind, amountCents, limitCents, triggerCents, planItems }: GlimLineInput): string {
  const amount = amountCents === null ? "" : formatUsd(amountCents);
  const limit = limitCents === null ? "" : formatUsd(limitCents);
  switch (kind) {
    case "plan_started":
      return `${planItems.map((item) => `${item.shortTitle} up to ${formatUsd(item.maxCents)}`).join(", ")}.`;
    case "bid":
      return `I bid ${amount} for you. I’ll go up to ${limit}.`;
    case "raise": {
      const atLimit = amountCents !== null && amountCents === limitCents;
      const rival = triggerCents === null ? "Someone outbid you" : `Someone bid ${formatUsd(triggerCents)}`;
      return `${rival}. I raised to ${amount}${atLimit ? ", your limit for this lot." : "."}`;
    }
    case "limit_reached":
      return `Someone bid ${amount}, over your ${limit} limit.`;
    case "lot_won":
      return `Bidding closed. You won at ${amount}.`;
    case "lot_lost":
      return `Bidding closed at ${amount}. You didn’t win, so you won’t be charged.`;
  }
}

export function glimChip(kind: GlimActionKind): GlimChip {
  switch (kind) {
    case "bid":
    case "raise":
      return "winning";
    case "lot_won":
    case "lot_lost":
      return "closed";
    case "plan_started":
    case "limit_reached":
      return "none";
  }
}
