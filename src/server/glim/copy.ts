/**
 * Every line Glim shows that code writes rather than the model. Amounts come from validated data,
 * so they are exact. Lines marked "approved" match the approved mockups; the rest wait for the
 * Sheet B review of 07's undrawn states.
 */
import { formatUsd } from "./money";

/** Approved: the fallback after a refusal or an API error (build plan, section 2). */
export const FALLBACK_LINE = "You can still bid yourself.";

/** Approved: 07's greeting, shown by the panel before the guest's first message. */
export function greeting(firstName: string): string {
  return `Hi ${firstName}. What’s your budget tonight?`;
}

/** Approved (09's bubble): the cue for suggest_hold_amount. */
export const HOLD_SUGGESTION_CUE = "Not sure how much? Tell me which lots you like. I’ll suggest an amount.";

export const CAP_REACHED_LINE = `I’ve answered all the messages I can tonight. ${FALLBACK_LINE}`;

export const EMPTY_MESSAGE_LINE = "Tell me your budget and the lots you like, and I’ll suggest a plan.";

export const TOO_LONG_LINE = "That’s a long message. Could you say it in a sentence or two?";

/** Replaces a model reply whose amounts the guard could not vouch for. */
export function amountGuardLine(holdCents: number | null, leftCents: number | null): string {
  if (holdCents === null) return "Your bidding power isn’t set yet. Set it first, then I can plan your bids.";
  if (leftCents === null) return `Your bidding power is ${formatUsd(holdCents)}.`;
  return `You have ${formatUsd(leftCents)} of your ${formatUsd(holdCents)} bidding power left.`;
}

export const NO_HOLD_LINE = "Set your bidding power first. Then I can plan your bids.";

export const NOTHING_FITS_LINE = `I couldn’t fit that within your bidding power. ${FALLBACK_LINE}`;

/** Waits for design/22: what Glim says when the guest pauses it. */
export const PAUSED_LINE = "I won’t bid or change your plan until you resume. Your bids stand.";

/** Waits for design/22: what Glim says on Resume, with the plan's lots ("Chef’s Table up to $380, Spa Day up to $120."). */
export function resumedLine(planLine: string): string {
  return planLine ? `I’m back on duty. ${planLine}` : "I’m back on duty.";
}

/** The plan's lots and maximums in one line, as 10's approved "Plan started" row reads. */
export function planLine(items: readonly { shortTitle: string; maxCents: number }[]): string {
  return items.length === 0 ? "" : `${items.map((item) => `${item.shortTitle} up to ${formatUsd(item.maxCents)}`).join(", ")}.`;
}
