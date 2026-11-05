/**
 * What each simulated guest wants, for the director that bids for them during a demo. Derived
 * from the story, so a director that follows the profiles moves every lot toward the approved
 * outcome: each story winner's max is its winning bid, and everyone else's stops below it.
 */
import type { AuctionScript, ReplayResult } from "./replay";
import { pm } from "./storyClock";

export interface BotTarget {
  lotNumber: number;
  /** The most this guest bids on the lot. */
  maxCents: number;
}

export type BotTiming = "early" | "steady" | "late";

export interface BotProfile {
  version: 1;
  /** The guest's whole hold; the engine still refuses any bid that would overcommit it. */
  budgetCents: number;
  targets: BotTarget[];
  /** Whether the guest let Glim bid in the story. */
  usesGlim: boolean;
  timing: BotTiming;
}

const EARLY_UNTIL = pm("8:15");
const LATE_FROM = pm("9:20");

/** One profile per simulated paddle in `script`, from the story replayed to its end. */
export function deriveBotProfiles(
  script: AuctionScript,
  finalState: ReplayResult,
  simulatedPaddles: ReadonlySet<number>,
): Map<number, BotProfile> {
  const profiles = new Map<number, BotProfile>();
  for (const paddle of script.paddles) {
    if (!simulatedPaddles.has(paddle.number)) continue;

    const maxByLot = new Map<number, number>();
    const raise = (lot: number, cents: number) => maxByLot.set(lot, Math.max(maxByLot.get(lot) ?? 0, cents));
    const bids = finalState.bids.filter((bid) => bid.paddle === paddle.number);
    for (const bid of bids) raise(bid.lot, bid.amountCents);
    for (const limit of finalState.limits) {
      if (limit.paddle === paddle.number) raise(limit.lot, limit.maxCents);
    }

    const lastBidAt = bids.at(-1)?.at;
    const timing: BotTiming =
      lastBidAt === undefined || lastBidAt < EARLY_UNTIL ? "early" : lastBidAt >= LATE_FROM ? "late" : "steady";

    profiles.set(paddle.number, {
      version: 1,
      budgetCents: paddle.holdCents,
      targets: [...maxByLot]
        .sort(([a], [b]) => a - b)
        .map(([lotNumber, maxCents]) => ({ lotNumber, maxCents })),
      usesGlim: finalState.plans.some((plan) => plan.paddle === paddle.number),
      timing,
    });
  }
  return profiles;
}
