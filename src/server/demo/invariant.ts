/**
 * The hold invariant over a plan's final rows, by the rule placeBid enforces (the engine's
 * commitmentCents): per paddle, on each open lot the larger of its active limit and its leading
 * bid, on each closed lot the amount it won, never more in total than the authorized hold. Seeds
 * check it before inserting anything.
 */
import { commitmentCents } from "@/server/engine/rules";

import type { EventPlan } from "./plan";

export interface Commitment {
  paddleNumber: number;
  committedCents: number;
  holdCents: number;
}

export function commitments(plan: EventPlan): Commitment[] {
  const holdOf = new Map(plan.holds.map((hold) => [hold.paddleNumber, hold.amountCents]));
  const limitOf = new Map(
    plan.bidLimits
      .filter((limit) => limit.active)
      .map((limit) => [`${limit.paddleNumber}:${limit.lotNumber}`, limit.maxCents]),
  );
  // The engine's rule speaks paddle ids; in a plan a paddle's number is its id.
  const id = (paddleNumber: number | null) => (paddleNumber === null ? null : String(paddleNumber));

  return plan.paddles.map((paddle) => ({
    paddleNumber: paddle.number,
    committedCents: plan.lots.reduce(
      (sum, lot) =>
        sum +
        commitmentCents(
          {
            status: lot.status,
            highPaddleId: id(lot.highPaddleNumber),
            currentBidCents: lot.currentBidCents,
            winningPaddleId: id(lot.winningPaddleNumber),
            winningCents: lot.winningCents,
          },
          String(paddle.number),
          limitOf.get(`${paddle.number}:${lot.number}`) ?? null,
        ),
      0,
    ),
    holdCents: holdOf.get(paddle.number) ?? 0,
  }));
}

export function assertWithinHolds(plan: EventPlan): void {
  const over = commitments(plan).filter((row) => row.committedCents > row.holdCents);
  if (over.length > 0) {
    const list = over.map((row) => `paddle ${row.paddleNumber} (${row.committedCents} of ${row.holdCents})`);
    throw new Error(`Seed would overcommit ${list.join(", ")}`);
  }
}
