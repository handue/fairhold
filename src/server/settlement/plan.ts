/**
 * The arithmetic of a settlement, on its own so it can be tested without a database: one item per
 * authorized hold, and the identifiers PayPal sees. Nothing here reads a clock or a table.
 */
import { paypalRequestId, type PaypalRequestScope } from "@/server/paypal/idempotency";
import type { HoldKind } from "@/server/paypal/payments";

import type { SettlementAction } from "./types";

export interface PlanHold {
  paddleId: string;
  paddleNumber: number;
  holdId: string;
  kind: HoldKind;
  holdCents: number;
}

export interface PlannedItem {
  paddleId: string;
  paddleNumber: number;
  holdId: string;
  action: SettlementAction;
  amountCents: number;
  releasedCents: number;
}

export interface SettlementPlan {
  items: PlannedItem[];
  winners: number;
  nonWinners: number;
  toChargeCents: number;
  toReleaseCents: number;
}

export type PlanProblem = { paddleId: string; code: "no_hold" | "over_hold" };

/**
 * Every authorized hold becomes one item: capture what a real paddle won, void a real hold that won
 * nothing, and settle a simulated guest in the database. A won total above its hold, or a winner
 * with no hold at all, leaves no plan: no capture may ever exceed its authorization.
 */
export function planSettlement(
  holds: readonly PlanHold[],
  wonCentsByPaddle: ReadonlyMap<string, number>,
): { ok: true; plan: SettlementPlan } | { ok: false; problems: PlanProblem[] } {
  const holdOf = new Map(holds.map((hold) => [hold.paddleId, hold]));
  const problems: PlanProblem[] = [];
  for (const [paddleId, wonCents] of wonCentsByPaddle) {
    const hold = holdOf.get(paddleId);
    if (!hold) problems.push({ paddleId, code: "no_hold" });
    else if (wonCents > hold.holdCents) problems.push({ paddleId, code: "over_hold" });
  }
  if (problems.length > 0) return { ok: false, problems };

  const items = holds.map((hold): PlannedItem => {
    const wonCents = wonCentsByPaddle.get(hold.paddleId) ?? 0;
    return {
      paddleId: hold.paddleId,
      paddleNumber: hold.paddleNumber,
      holdId: hold.holdId,
      action: hold.kind === "simulated" ? "simulate" : wonCents > 0 ? "capture" : "void",
      amountCents: wonCents,
      releasedCents: hold.holdCents - wonCents,
    };
  });

  return {
    ok: true,
    plan: {
      items,
      winners: items.filter((item) => item.amountCents > 0).length,
      nonWinners: items.filter((item) => item.amountCents === 0).length,
      toChargeCents: items.reduce((sum, item) => sum + item.amountCents, 0),
      toReleaseCents: items.reduce((sum, item) => sum + item.releasedCents, 0),
    },
  };
}

/**
 * PayPal refuses a reused invoice_id account-wide. An event's id and a paddle number make it unique
 * per item, and it stays the same on every attempt: if an earlier attempt did capture, the next one
 * is refused instead of charging twice.
 */
export function invoiceIdFor(eventId: string, paddleNumber: number): string {
  return `FH-${eventId}-${paddleNumber}`;
}

/** What PayPal shows the buyer next to the charge: at most 255 characters, and no tax language. */
export function noteToPayerFor(charityName: string): string {
  return `Thank you for supporting ${charityName}.`.slice(0, 255);
}

// One deliberate attempt at an item gets this many tries with one PayPal-Request-Id.
export const TRIES_PER_ATTEMPT = 5;

/**
 * settlement_items.attempts counts tries, and an organizer's retry jumps it to the next multiple of
 * TRIES_PER_ATTEMPT, so the one column says which deliberate attempt this is (1-based) and how many
 * tries that attempt has used.
 */
export function attemptNumber(tries: number): number {
  return Math.max(1, Math.ceil(tries / TRIES_PER_ATTEMPT));
}

export function triesInAttempt(tries: number): number {
  return tries - (attemptNumber(tries) - 1) * TRIES_PER_ATTEMPT;
}

/** Where `attempts` stands after an organizer's retry: the next claim opens a fresh attempt. */
export function triesAfterRetry(tries: number): number {
  return attemptNumber(tries) * TRIES_PER_ATTEMPT;
}

/** Seconds before the next try of the same attempt, after try `n` failed with no decided outcome. */
const BACKOFF_SECONDS = [2, 8, 30, 120] as const;

export function backoffSeconds(triesUsed: number): number {
  const index = Math.min(triesUsed, BACKOFF_SECONDS.length) - 1;
  return BACKOFF_SECONDS[Math.max(0, index)] ?? BACKOFF_SECONDS[0];
}

const REQUEST_SCOPE: Record<Exclude<SettlementAction, "simulate">, PaypalRequestScope> = {
  capture: "capture",
  void: "void",
};

/** The PayPal-Request-Id of one attempt at an item. A simulated item never calls PayPal, so it has none. */
export function itemRequestId(action: SettlementAction, itemId: string, attempt = 1): string | null {
  return action === "simulate" ? null : paypalRequestId(REQUEST_SCOPE[action], itemId, attempt);
}
