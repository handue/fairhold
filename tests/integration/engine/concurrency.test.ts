import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  closeEvent,
  getBiddingPower,
  placeBid,
  setMaxBid,
  type PlaceBidResult,
} from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";
import { invariantViolations, pick } from "../../unit/engine/support/auction-model";

import { createEvent, createHold, createLot, createPaddle } from "./support/fixtures";
import { pgView } from "./support/pg-world";

const { pool: setupPool, url } = getTestDatabase();
const BIDDERS = 50;
const HOLD_CENTS = 50_000;

/** Fifty connections, so fifty engine transactions really are in flight at once. */
const pool = new pg.Pool({ connectionString: url, max: BIDDERS });

afterAll(async () => {
  await pool.end();
});

/** A fixed shuffle (linear congruential), so a failure reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [result[index], result[other]] = [pick(result, other), pick(result, index)];
  }
  return result;
}

/** Starts every operation at once; any rejection (deadlock, lock timeout, crash) fails the test. */
async function race<T>(operations: (() => Promise<T>)[]): Promise<T[]> {
  const settled = await Promise.allSettled(operations.map((operation) => operation()));
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  expect(failures, "no deadlock, lock timeout or other error").toEqual([]);
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

const reasons = (results: PlaceBidResult[]) => results.map((result) => (result.ok ? "ok" : result.refusal.reason));

describe("50 bidders at once", () => {
  it("never overspend a hold, never accept a bid after close and never crown two winners", { timeout: 180_000 }, async () => {
    const eventId = await createEvent(setupPool);
    const paddleIds: string[] = [];
    for (let index = 0; index < BIDDERS; index += 1) {
      const paddleId = await createPaddle(setupPool, eventId, 200 + index);
      await createHold(setupPool, eventId, paddleId, HOLD_CENTS);
      paddleIds.push(paddleId);
    }
    const sharedLots: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      sharedLots.push(
        await createLot(setupPool, eventId, { number: index + 1, startingBidCents: 10_000, minRaiseCents: 500 }),
      );
    }
    const ownLots: [string, string][] = [];
    for (let index = 0; index < BIDDERS; index += 1) {
      const lot = { startingBidCents: 30_000, minRaiseCents: 500 };
      ownLots.push([
        await createLot(setupPool, eventId, { number: 100 + 2 * index, ...lot }),
        await createLot(setupPool, eventId, { number: 101 + 2 * index, ...lot }),
      ]);
    }
    const lotIds = [...sharedLots, ...ownLots.flat()];
    const expectConsistent = async () => {
      expect(invariantViolations(await pgView(setupPool, eventId, lotIds, paddleIds))).toEqual([]);
      for (const power of (await getBiddingPower(paddleIds, setupPool)).values()) {
        expect(power.committedCents).toBeLessThanOrEqual(power.holdCents);
      }
    };

    // The lot lock: fifty bids at the same opening minimum, exactly one accepted.
    const opening = await race(
      paddleIds.map((paddleId) => () => placeBid(paddleId, pick(sharedLots, 0), 10_000, "guest", { pool })),
    );
    expect(reasons(opening).filter((reason) => reason === "ok")).toHaveLength(1);
    expect(reasons(opening).filter((reason) => reason === "below_minimum")).toHaveLength(BIDDERS - 1);

    // The hold lock: every bidder races two $300 bids on lots nobody else bids on, against its
    // $500 hold. Each fits alone and not together, so exactly one per bidder may win.
    const pairs = await race(
      paddleIds.flatMap((paddleId, index) =>
        pick(ownLots, index).map((lotId) => async () => ({
          paddleId,
          result: await placeBid(paddleId, lotId, 30_000, "guest", { pool }),
        })),
      ),
    );
    for (const paddleId of paddleIds) {
      const mine = pairs.filter((pair) => pair.paddleId === paddleId).map((pair) => pair.result);
      expect(reasons(mine).sort()).toEqual(["ok", "over_bidding_power"]);
    }
    await expectConsistent();

    // Proxy wars under contention: everyone sets a max on one shared lot while bidding by hand
    // on another, with $200 of hold left, so the max and the bid compete for the same room.
    for (let wave = 0; wave < 4; wave += 1) {
      const operations = paddleIds.flatMap((paddleId, index): (() => Promise<unknown>)[] => [
        () => setMaxBid(paddleId, pick(sharedLots, (index + wave) % 3), 11_000 + ((index * 37 + wave) % 19) * 500, { pool }),
        () => placeBid(paddleId, pick(sharedLots, (index + wave + 1) % 3), 10_500 + ((index * 53 + wave) % 19) * 500, "guest", { pool }),
      ]);
      await race(shuffled(operations, wave + 1));
      await expectConsistent();
    }
    const { rows: proxied } = await setupPool.query<{ count: number }>(
      "select count(*)::int as count from bids where limit_id is not null and lot_id = any($1)",
      [sharedLots],
    );
    // How many depends only on how the operations interleave (in-memory replays give 25 in this
    // order, 62 with every max first and 3 with every hand bid first), so only "some" is stable.
    expect(proxied[0]?.count, "the waves set off proxy wars").toBeGreaterThan(0);

    // Closing while fifty more bids are in flight, then nothing gets in.
    const lastCall = paddleIds.map(
      (paddleId, index) => () => placeBid(paddleId, pick(sharedLots, index % 3), 15_000 + index * 500, "guest", { pool }),
    );
    await race(shuffled<() => Promise<unknown>>([...lastCall, () => closeEvent(eventId, { pool })], 99));
    expect(new Set(reasons(await race(lastCall.slice(0, 10))))).toEqual(new Set(["lot_closed"]));
    await expectConsistent();

    const { rows: lots } = await setupPool.query<{ status: string }>("select status from lots where event_id = $1", [eventId]);
    expect(lots.every((lot) => lot.status === "closed")).toBe(true);
    // A winner is the only bid at or above the winning amount, and it is the winner's own bid.
    const { rows: wrongWinners } = await setupPool.query(
      `select l.id
       from lots l
       join bids b on b.lot_id = l.id and b.amount_cents >= l.winning_cents
       where l.event_id = $1
       group by l.id
       having count(*) <> 1 or bool_or(b.paddle_id is distinct from l.winning_paddle_id)`,
      [eventId],
    );
    expect(wrongWinners).toEqual([]);
  });
});
