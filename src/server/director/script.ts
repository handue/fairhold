/**
 * The background of a demo gala: every simulated guest's bot profile turned into dated bids, so the
 * room feels alive on its 25-minute schedule. The script is planned once, when the demo starts, by
 * playing each lot forward at the minimum raise: low bidders drop out first and the guest the story
 * wants most ends up ahead. Each job decides its real bid when it runs, so a guest who joins a lot
 * only shortens that lot's contest.
 */
import type { BotProfile } from "@/server/demo/botProfiles";
import type { PersistedEvent } from "@/server/demo/persist";
import type { EventPlan } from "@/server/demo/plan";
import type { Queryable } from "@/server/db/transaction";
import { nextMinimumCents } from "@/server/engine/rules";

import { insertJobs, type NewJob } from "./jobs";
import { directorCeilingCents, DESTINATION_MIN_LEFT_MS, LOT_WINE_TASTING, REACTIVE_ONLY_LOTS } from "./rules";
import { DIRECTOR_SEED, seededRandom } from "./seed";

/** Nothing moves in the first seconds of a demo, while its creator is still landing on 08. */
const FIRST_BID_AFTER_MS = 20_000;
const LAST_BID_BEFORE_CLOSE_MS = 10_000;
/** Wine Tasting stays quiet until the golden take no longer needs it at $210, then has a short finish. */
const WINE_TASTING_FINISH_BIDS = 6;
const WINE_TASTING_FINISH_AFTER_WINDOW_MS = 5_000;
/** Lots of nothing but late bidders start here, as a share of their window. */
const LATE_START_SHARE = 0.5;
/** Pulls bids toward the start of each window, when the creator is most likely to be watching. */
const EARLY_BIAS = 1.35;

export interface ScriptLot {
  number: number;
  startingBidCents: number;
  minRaiseCents: number;
  currentBidCents: number | null;
  highPaddleNumber: number | null;
  closesAt: Date;
}

export interface ScriptPaddle {
  number: number;
  botProfile: BotProfile | null;
}

export interface BackgroundInput {
  /** The instant the demo opens. */
  start: Date;
  lots: readonly ScriptLot[];
  paddles: readonly ScriptPaddle[];
  seed?: string;
}

export interface PlannedBotBid {
  paddleNumber: number;
  lotNumber: number;
  /** The most this guest bids on this lot: their profile's max, under the director's ceiling. */
  maxCents: number;
  runAt: Date;
}

interface Bidder {
  number: number;
  maxCents: number;
  late: boolean;
}

function biddersOn(lot: ScriptLot, paddles: readonly ScriptPaddle[]): Bidder[] {
  const ceiling = directorCeilingCents(lot.number);
  return paddles.flatMap((paddle) => {
    const target = paddle.botProfile?.targets.find((entry) => entry.lotNumber === lot.number);
    if (!paddle.botProfile || !target) return [];
    return [{ number: paddle.number, maxCents: Math.min(target.maxCents, ceiling), late: paddle.botProfile.timing === "late" }];
  });
}

/** The lot played forward at the minimum raise: who bids, in order, with nobody bidding against themselves. */
function contest(lot: ScriptLot, bidders: readonly Bidder[]): Bidder[] {
  const turns: Bidder[] = [];
  let leader = lot.highPaddleNumber;
  let nextCents = nextMinimumCents({
    highPaddleId: lot.highPaddleNumber === null ? null : String(lot.highPaddleNumber),
    currentBidCents: lot.currentBidCents,
    startingBidCents: lot.startingBidCents,
    minRaiseCents: lot.minRaiseCents,
  });
  for (;;) {
    const able = bidders.filter((bidder) => bidder.number !== leader && bidder.maxCents >= nextCents);
    const next = able.reduce<Bidder | null>(
      (lowest, bidder) =>
        lowest === null || bidder.maxCents < lowest.maxCents || (bidder.maxCents === lowest.maxCents && bidder.number < lowest.number)
          ? bidder
          : lowest,
      null,
    );
    if (!next) return turns;
    turns.push(next);
    leader = next.number;
    nextCents += lot.minRaiseCents;
  }
}

/** The stretch of a lot's life when bots may bid on it, in epoch ms. */
function biddingWindow(lot: ScriptLot, start: Date, turns: readonly Bidder[]): { from: number; to: number } {
  const to = lot.closesAt.getTime() - LAST_BID_BEFORE_CLOSE_MS;
  const first = start.getTime() + FIRST_BID_AFTER_MS;
  if (lot.number === LOT_WINE_TASTING) {
    return { from: Math.max(first, lot.closesAt.getTime() - DESTINATION_MIN_LEFT_MS + WINE_TASTING_FINISH_AFTER_WINDOW_MS), to };
  }
  const allLate = turns.every((turn) => turn.late);
  return { from: allLate ? first + (to - first) * LATE_START_SHARE : first, to };
}

/** Every background bid of a demo, in time order. The same input and seed always give the same script. */
export function planBackgroundBids({ start, lots, paddles, seed = DIRECTOR_SEED }: BackgroundInput): PlannedBotBid[] {
  const planned = lots.flatMap((lot) => {
    if (REACTIVE_ONLY_LOTS.has(lot.number)) return [];
    const all = contest(lot, biddersOn(lot, paddles));
    const turns = lot.number === LOT_WINE_TASTING ? all.slice(0, WINE_TASTING_FINISH_BIDS) : all;
    if (turns.length === 0) return [];

    const { from, to } = biddingWindow(lot, start, turns);
    const random = seededRandom(`${seed}:lot:${lot.number}`);
    return turns.map((turn, index) => {
      const share = (index + 0.15 + random() * 0.7) / turns.length;
      return {
        paddleNumber: turn.number,
        lotNumber: lot.number,
        maxCents: turn.maxCents,
        runAt: new Date(Math.round(from + (to - from) * share ** EARLY_BIAS)),
      };
    });
  });
  return planned.sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.lotNumber - b.lotNumber);
}

/** Queues a new demo's background inside its own transaction, so a demo never starts without one. */
export async function queueBackgroundBids(
  db: Queryable,
  plan: EventPlan,
  persisted: PersistedEvent,
  start: Date,
): Promise<number> {
  const idOf = (ids: ReadonlyMap<number, string>, number: number, what: string): string => {
    const id = ids.get(number);
    if (!id) throw new Error(`The demo has no ${what} ${number}`);
    return id;
  };
  const jobs: NewJob[] = planBackgroundBids({ start, lots: plan.lots, paddles: plan.paddles }).map((bid) => ({
    eventId: persisted.eventId,
    kind: "bot_bid",
    runAt: bid.runAt,
    payload: {
      paddleId: idOf(persisted.paddleIds, bid.paddleNumber, "paddle"),
      paddleNumber: bid.paddleNumber,
      lotId: idOf(persisted.lotIds, bid.lotNumber, "lot"),
      lotNumber: bid.lotNumber,
      maxCents: bid.maxCents,
    },
  }));
  return insertJobs(db, jobs);
}
