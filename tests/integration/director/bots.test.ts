/** A whole demo gala's background, played on Postgres with the clock in the test's hands. */
import { beforeEach, describe, expect, it } from "vitest";

import { insertJobs } from "@/server/director/jobs";
import { runDueJobs } from "@/server/director/run";
import { getBiddingPower, placeBid } from "@/server/engine";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";

import { bidByHand, giveHold, jobsOf, lotRow, rows, startGala, walk } from "./support";

const { pool } = getTestDatabase();

beforeEach(async () => {
  await pool.query("delete from events");
});

async function overcommitted(eventId: string): Promise<number[]> {
  const paddles = await rows<{ id: string; number: number }>(pool, "select id, number from paddles where event_id = $1", [eventId]);
  const power = await getBiddingPower(paddles.map((paddle) => paddle.id), pool);
  return paddles.filter((paddle) => (power.get(paddle.id)?.committedCents ?? 0) > (power.get(paddle.id)?.holdCents ?? 0)).map((paddle) => paddle.number);
}

describe("the background bots", () => {
  it("queues a demo's script with the demo itself", async () => {
    const gala = await startGala(pool);
    const jobs = await jobsOf(pool, gala.eventId);
    expect(jobs.length).toBeGreaterThanOrEqual(50);
    expect(new Set(jobs.map((job) => job.kind))).toEqual(new Set(["bot_bid"]));
    expect(jobs.every((job) => job.status === "queued")).toBe(true);
    expect(jobs[0]?.run_at.getTime()).toBeGreaterThan(gala.at(0, 19).getTime());
    expect(jobs.at(-1)?.run_at.getTime()).toBeLessThan(gala.at(25).getTime());
  });

  it("plays 25 minutes of bids, and every bid is a simulated guest's, within their hold and profile", async () => {
    const gala = await startGala(pool);
    const before = await rows<{ raised: number }>(pool, "select coalesce(sum(current_bid_cents), 0)::int as raised from lots where event_id = $1", [gala.eventId]);
    const payments = getSimulatedPayments();
    const voidCalls: unknown[] = [];
    const realVoid = payments.void.bind(payments);
    payments.void = async (request) => {
      voidCalls.push(request);
      return realVoid(request);
    };

    const reports = await walk(pool, gala.start, gala.at(25));
    payments.void = realVoid;

    const placed = reports.filter((report) => report.result?.outcome === "bid");
    expect(placed.length).toBeGreaterThanOrEqual(40);
    expect(reports.every((report) => report.status === "done")).toBe(true);
    expect((await jobsOf(pool, gala.eventId)).every((job) => job.status === "done")).toBe(true);

    // The room moved.
    const after = await rows<{ raised: number; open: number }>(pool, "select coalesce(sum(current_bid_cents), 0)::int as raised, count(*)::int as open from lots where event_id = $1", [gala.eventId]);
    expect(after[0]?.raised ?? 0).toBeGreaterThan((before[0]?.raised ?? 0) + 50_000);

    // Nobody is over their hold, by the engine's own calculation.
    expect(await overcommitted(gala.eventId)).toEqual([]);

    // Labeled simulated in the data, on the paddle and on the hold, and bidding as a bot.
    const bids = await rows<{ source: string; is_simulated: boolean; hold_kind: string; max_cents: number | null; amount_cents: number }>(
      pool,
      `select b.source, pd.is_simulated, h.kind as hold_kind, b.amount_cents,
         (select (t->>'maxCents')::int from jsonb_array_elements(pd.bot_profile->'targets') t where (t->>'lotNumber')::int = l.number) as max_cents
       from bids b
       join lots l on l.id = b.lot_id
       join paddles pd on pd.id = b.paddle_id
       join holds h on h.paddle_id = pd.id and h.status = 'authorized'
       where l.event_id = $1 and b.created_at >= $2`,
      [gala.eventId, gala.start],
    );
    expect(bids.length).toBe(placed.length);
    for (const bid of bids) {
      expect(bid).toMatchObject({ source: "bot", is_simulated: true, hold_kind: "simulated" });
      expect(bid.amount_cents).toBeLessThanOrEqual(bid.max_cents ?? 0);
    }

    // Simulated guests never reach the payments interface.
    expect(voidCalls).toEqual([]);
  });

  it("leaves Chef's Table and Spa Day untouched and keeps Wine Tasting at or under $370", async () => {
    const gala = await startGala(pool);
    const chef = await lotRow(pool, gala.lot(7));
    const spa = await lotRow(pool, gala.lot(12));

    await walk(pool, gala.start, gala.at(10, 29));
    expect((await lotRow(pool, gala.lot(9))).current_bid_cents).toBe(21_000);

    await walk(pool, gala.at(10, 29), gala.at(25));
    expect(await lotRow(pool, gala.lot(7))).toEqual(chef);
    expect(await lotRow(pool, gala.lot(12))).toEqual(spa);
    const wine = await rows<{ amount_cents: number }>(
      pool,
      "select amount_cents from bids where lot_id = $1 and source = 'bot' order by amount_cents desc limit 1",
      [gala.lot(9)],
    );
    expect(wine[0]?.amount_cents).toBeGreaterThan(21_000);
    expect(wine[0]?.amount_cents).toBeLessThanOrEqual(37_000);
  });

  it("refuses through the engine a bot with too little hold: nothing is written", async () => {
    const gala = await startGala(pool);
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    // Paddle 92 holds $250; Lot 01 is at $1,150.
    await insertJobs(pool, [
      {
        eventId: gala.eventId,
        kind: "bot_bid",
        runAt: gala.at(0, 10),
        payload: { paddleId: gala.paddle(92), paddleNumber: 92, lotId: gala.lot(1), lotNumber: 1, maxCents: 1_000_000 },
      },
    ]);
    const before = await lotRow(pool, gala.lot(1));
    const [report] = await runDueJobs({ pool, now: gala.at(0, 11) });
    expect(report?.result).toEqual({ outcome: "refused", reason: "over_bidding_power" });
    expect(await lotRow(pool, gala.lot(1))).toEqual(before);
    expect(await overcommitted(gala.eventId)).toEqual([]);
    expect((await jobsOf(pool, gala.eventId))[0]).toMatchObject({ status: "done", payload: { result: { outcome: "refused" } } });
  });

  it("counts every lot a bot leads against its hold", async () => {
    const gala = await startGala(pool);
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    const paddle = gala.paddle(92);
    await pool.query("update holds set amount_cents = 30_000 where paddle_id = $1 and status = 'authorized'", [paddle]);
    await pool.query("delete from bids where paddle_id = $1", [paddle]);
    // $160 on Lot 05 and $130 on Lot 18 fit its $300; $160 more on Lot 16 does not.
    const make = (lot: number, seconds: number) => ({
      eventId: gala.eventId,
      kind: "bot_bid" as const,
      runAt: gala.at(0, seconds),
      payload: { paddleId: paddle, paddleNumber: 92, lotId: gala.lot(lot), lotNumber: lot, maxCents: 1_000_000 },
    });
    await insertJobs(pool, [make(5, 1), make(18, 2), make(16, 3)]);
    const reports = await runDueJobs({ pool, now: gala.at(0, 4) });
    expect(reports.map((report) => report.result?.outcome)).toEqual(["bid", "bid", "refused"]);
    expect(await overcommitted(gala.eventId)).toEqual([]);
  });

  it("does not bid against itself, past its profile, on a closed lot or after bidding closes", async () => {
    const gala = await startGala(pool);
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    const job = (paddle: number, lot: number, seconds: number, maxCents: number) => ({
      eventId: gala.eventId,
      kind: "bot_bid" as const,
      runAt: gala.at(0, seconds),
      payload: { paddleId: gala.paddle(paddle), paddleNumber: paddle, lotId: gala.lot(lot), lotNumber: lot, maxCents },
    });
    // 175 leads Lot 01 at $1,150; 131 stops at $1,160, under the next minimum of $1,175.
    await insertJobs(pool, [job(175, 1, 1, 200_000), job(131, 1, 2, 116_000)]);
    expect((await runDueJobs({ pool, now: gala.at(0, 3) })).map((report) => report.result)).toEqual([
      { outcome: "skipped", reason: "already_leading" },
      { outcome: "skipped", reason: "past_max" },
    ]);

    // On the test's clock the lot has closed, with 5 seconds or less left counting as closed.
    const closed = gala.at(25);
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    await insertJobs(pool, [{ ...job(131, 1, 0, 200_000), runAt: new Date(closed.getTime() - 1_000) }]);
    expect((await runDueJobs({ pool, now: closed })).map((report) => report.result)).toEqual([{ outcome: "skipped", reason: "lot_closed" }]);

    // The engine has the last word: its clock refuses a lot past closes_at, whatever the job's clock says.
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    await pool.query("update lots set closes_at = now() where id = $1", [gala.lot(2)]);
    const stillOpenByTheJobsClock = new Date(Date.now() - 60_000);
    await insertJobs(pool, [{ ...job(168, 2, 0, 200_000), runAt: stillOpenByTheJobsClock }]);
    expect((await runDueJobs({ pool, now: stillOpenByTheJobsClock })).map((report) => report.result)).toEqual([{ outcome: "refused", reason: "lot_closed" }]);
  });

  it("never bids for a real guest, even from a forged job", async () => {
    const gala = await startGala(pool);
    await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
    await giveHold(pool, gala, gala.jamie, 500_000);
    await insertJobs(pool, [
      {
        eventId: gala.eventId,
        kind: "bot_bid",
        runAt: gala.at(0, 1),
        payload: { paddleId: gala.jamie, paddleNumber: 142, lotId: gala.lot(1), lotNumber: 1, maxCents: 500_000 },
      },
    ]);
    const before = await lotRow(pool, gala.lot(1));
    const [report] = await runDueJobs({ pool, now: gala.at(0, 2) });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "not_simulated" });
    expect(await lotRow(pool, gala.lot(1))).toEqual(before);
  });

  it("carries on around a guest who joins a lot, up to each bot's max", async () => {
    const gala = await startGala(pool);
    await giveHold(pool, gala, gala.jamie, 100_000);
    await walk(pool, gala.start, gala.at(0, 21));
    // Jamie takes the lead on Lot 23 at $230.
    await bidByHand(pool, gala.jamie, gala.lot(23), 23_000);
    await walk(pool, gala.at(0, 21), gala.at(25));
    // 117 goes to $260 and 165 to $250, so Jamie is outbid and the lot passes $230.
    const lot = await lotRow(pool, gala.lot(23));
    expect(lot.current_bid_cents).toBeGreaterThan(23_000);
    expect(lot.current_bid_cents).toBeLessThanOrEqual(26_000);
    expect(lot.high_bid_source).toBe("bot");
    expect(await overcommitted(gala.eventId)).toEqual([]);
  });

  it("keeps to the ceiling on Wine Tasting with a guest in the lead there too", async () => {
    const gala = await startGala(pool);
    await giveHold(pool, gala, gala.jamie, 100_000);
    const placed = await placeBid(gala.jamie, gala.lot(9), 22_000, "guest", { pool });
    expect(placed.ok).toBe(true);
    const reports = await walk(pool, gala.start, gala.at(11, 59));
    expect(reports.some((report) => report.result?.outcome === "bid" && report.result.lotNumber === 9)).toBe(true);
    const bids = await rows<{ amount_cents: number }>(pool, "select amount_cents from bids where lot_id = $1 and source = 'bot' and amount_cents > 21000", [gala.lot(9)]);
    expect(bids.every((bid) => bid.amount_cents <= 37_000)).toBe(true);
  });
});
