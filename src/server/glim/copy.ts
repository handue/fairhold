/**
 * Every line Glim shows that code writes rather than the model. Amounts come from validated data,
 * so they are exact. Each line matches the approved 07 mockup or design/22 (Glim chat states).
 */
import { formatUsd } from "./money";

/** Approved: the fallback after a refusal or an API error (build plan, section 2). */
export const FALLBACK_LINE = "You can still bid yourself.";

/** design/22 #4: what Glim says when the model fails or refuses, the approved line with its reason first. */
export const ERROR_LINE = `I can’t answer right now. ${FALLBACK_LINE}`;

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

/** design/22 #10: what Glim says when the guest pauses it. */
export const PAUSED_LINE = "I won’t bid or change your plan until you resume. Your bids stand.";

/** design/22 #11: what Glim says on Resume, with the plan's lots ("Chef’s Table up to $380, Spa Day up to $120."). */
export function resumedLine(planLine: string): string {
  return planLine ? `I’m back on duty. ${planLine}` : "I’m back on duty.";
}

/** The plan's lots and maximums in one line, as 10's approved "Plan started" row reads. */
export function planLine(items: readonly { shortTitle: string; maxCents: number }[]): string {
  return items.length === 0 ? "" : `${items.map((item) => `${item.shortTitle} up to ${formatUsd(item.maxCents)}`).join(", ")}.`;
}

/** design/22 #2: the note under "Set bidding power". */
export const HOLD_NOT_CHARGE_NOTE = "It’s a hold with PayPal, not a charge.";

/** design/22 #5: the note under a raise offer's "Raise bidding power". */
export const RAISE_WINDOW_NOTE = "You’ll approve another hold in a PayPal window.";

/** design/22 #12: the input once bidding has closed. */
export const BIDDING_CLOSED_INPUT = "Bidding has closed.";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * design/22 #12 and #22: Glim's last card once bidding closes, from the lots the guest won and the
 * bidding power they held. "You won both lots in your plan. You’ll pay $470 with PayPal, and the
 * other $30 will be released." After the charge the same sentence reads in the past tense.
 */
export function biddingClosedLine(input: {
  wonCents: number;
  wonCount: number;
  /** How many of the won lots were in the guest's plan, and how many lots that plan had. */
  wonInPlan: number;
  planLots: number;
  /** The bidding power held when bidding closed; null when the guest never set one. */
  holdCents: number | null;
  charged: boolean;
}): string {
  const { wonCents, wonCount, holdCents, charged } = input;
  if (wonCount === 0) {
    const released = holdCents === null ? "" : charged ? ` All ${formatUsd(holdCents)} was released.` : ` All ${formatUsd(holdCents)} will be released.`;
    return `You didn’t win a lot tonight, so you won’t be charged.${released}`;
  }
  let won: string;
  if (input.planLots > 0 && input.wonInPlan === input.planLots && wonCount === input.planLots) {
    won = input.planLots === 1 ? "You won the lot in your plan." : input.planLots === 2 ? "You won both lots in your plan." : `You won all ${input.planLots} lots in your plan.`;
  } else {
    won = `You won ${plural(wonCount, "lot", "lots")}.`;
  }
  const rest = holdCents === null ? 0 : Math.max(0, holdCents - wonCents);
  if (charged) {
    return rest > 0
      ? `${won} You paid ${formatUsd(wonCents)} with PayPal, and the other ${formatUsd(rest)} was released.`
      : `${won} You paid ${formatUsd(wonCents)} with PayPal.`;
  }
  return rest > 0
    ? `${won} You’ll pay ${formatUsd(wonCents)} with PayPal, and the other ${formatUsd(rest)} will be released.`
    : `${won} You’ll pay ${formatUsd(wonCents)} with PayPal.`;
}
