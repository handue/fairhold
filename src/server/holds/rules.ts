/**
 * What amount a guest may put on hold. Pure, with no server imports, so the 09 page checks an amount
 * as it is typed by the same rules createHold enforces. Money is integer cents; holds are whole
 * dollars, because PayPal is asked for whole-dollar amounts (validateCreateAuthorizeOrder).
 */
import { formatUsd } from "@/server/paypal/money";

const DOLLAR_CENTS = 100;

/** The plan's cap on demo holds, for an event that names no maximum of its own. */
export const DEFAULT_HOLD_MAX_CENTS = 1_000 * DOLLAR_CENTS;
const DEFAULT_HOLD_MIN_CENTS = DOLLAR_CENTS;

export interface HoldLimits {
  /** The amounts offered as buttons, in the event's order. */
  presetsCents: readonly number[];
  minCents: number;
  maxCents: number;
}

/** A row's nullable limit columns with the defaults filled in. */
export function resolveHoldLimits(row: {
  presetsCents: readonly number[] | null;
  minCents: number | null;
  maxCents: number | null;
}): HoldLimits {
  return {
    presetsCents: row.presetsCents ?? [],
    minCents: row.minCents ?? DEFAULT_HOLD_MIN_CENTS,
    maxCents: row.maxCents ?? DEFAULT_HOLD_MAX_CENTS,
  };
}

/** Where the paddle stands: a new hold has to beat the first figure and cover the second. */
export interface HoldStanding {
  /** The paddle's authorized hold, if it has one. */
  currentHoldCents: number | null;
  /** The paddle's commitments by the engine's COMMITMENTS_SQL. */
  committedCents: number;
}

export type HoldRangeIssue =
  | { reason: "not_whole_dollars" }
  | { reason: "below_minimum"; minCents: number }
  | { reason: "above_maximum"; maxCents: number };

export type HoldAmountIssue =
  | HoldRangeIssue
  | { reason: "not_a_raise"; currentHoldCents: number }
  | { reason: "below_commitments"; committedCents: number };

/** Whole dollars, within the event's minimum and maximum. */
export function holdRangeIssue(amountCents: number, limits: Pick<HoldLimits, "minCents" | "maxCents">): HoldRangeIssue | null {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents % DOLLAR_CENTS !== 0) {
    return { reason: "not_whole_dollars" };
  }
  if (amountCents < limits.minCents) return { reason: "below_minimum", minCents: limits.minCents };
  if (amountCents > limits.maxCents) return { reason: "above_maximum", maxCents: limits.maxCents };
  return null;
}

/**
 * The range, plus the two checks the raise swap makes when PayPal comes back (holdSwapRefusal in
 * src/server/paypal/hold-store.ts, which this file cannot import because that one reaches the
 * database). A window that fails either would be released the moment the guest approved it.
 * tests/unit/holds/rules.test.ts keeps the two in step.
 */
export function holdAmountIssue(
  amountCents: number,
  limits: Pick<HoldLimits, "minCents" | "maxCents">,
  { currentHoldCents, committedCents }: HoldStanding,
): HoldAmountIssue | null {
  const range = holdRangeIssue(amountCents, limits);
  if (range) return range;
  if (currentHoldCents !== null && amountCents <= currentHoldCents) return { reason: "not_a_raise", currentHoldCents };
  if (amountCents < committedCents) return { reason: "below_commitments", committedCents };
  return null;
}

/** One sentence a guest can read, for the API's error and the page's own check. */
export function holdAmountMessage(issue: HoldAmountIssue): string {
  switch (issue.reason) {
    case "not_whole_dollars":
      return "Enter a whole dollar amount.";
    case "below_minimum":
      return `The least you can hold is ${formatUsd(issue.minCents)}.`;
    case "above_maximum":
      return `The most you can hold is ${formatUsd(issue.maxCents)}.`;
    case "not_a_raise":
      return `You already hold ${formatUsd(issue.currentHoldCents)}. Choose more than that.`;
    case "below_commitments":
      return `Your bids already need ${formatUsd(issue.committedCents)} of bidding power. Choose at least that.`;
  }
}

/** The smallest amount that passes holdAmountIssue, whole dollars; above maxCents when nothing does. */
export function lowestHoldCents(limits: Pick<HoldLimits, "minCents">, { currentHoldCents, committedCents }: HoldStanding): number {
  const floor = Math.max(limits.minCents, committedCents);
  const roundedUp = Math.ceil(floor / DOLLAR_CENTS) * DOLLAR_CENTS;
  if (currentHoldCents === null) return roundedUp;
  return Math.max(roundedUp, (Math.floor(currentHoldCents / DOLLAR_CENTS) + 1) * DOLLAR_CENTS);
}

/** The largest whole-dollar amount the event allows. */
export function highestHoldCents(limits: Pick<HoldLimits, "maxCents">): number {
  return Math.floor(limits.maxCents / DOLLAR_CENTS) * DOLLAR_CENTS;
}

/** Share of the hold that the explainer's example win takes: the approved $320 of $500. */
const EXAMPLE_WIN_PERCENT = 64;

/** The explainer's example win for a hold, in whole dollars, so its figures follow the amount chosen. */
export function exampleWinCents(holdCents: number): number {
  const dollars = Math.round(holdCents / DOLLAR_CENTS);
  return Math.round((dollars * EXAMPLE_WIN_PERCENT) / 100) * DOLLAR_CENTS;
}
