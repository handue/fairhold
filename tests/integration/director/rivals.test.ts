/**
 * The reactive rivals on real demo galas, on a clock the test moves: the golden take from Start
 * bidding to Glim's move with no tap, then each timing rule on its own.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { insertJobs } from "@/server/director/jobs";
import { scheduleReactions } from "@/server/director/reactions";
import { runDueJobs } from "@/server/director/run";
import { placeBid, setMaxBid } from "@/server/engine";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";
import { heart, makeDue, recordedModel, startBidding } from "../plans/support";

import { bidByHand, giveHold, jobsOf, lotRow, rows, startGala, walk, type DemoGala } from "./support";

const database = getTestDatabase();
const { pool } = database;

beforeEach(async () => {
  await pool.query("delete from events");
});

/** Jamie's golden path up to Start bidding: $500 held, $320 by hand on Lot 07, Wine Tasting hearted. */
async function goldenPlan(gala: DemoGala) {
  await giveHold(pool, gala, gala.jamie, 50_000);
  await bidByHand(pool, gala.jamie, gala.lot(7), 32_000);
  await heart(pool, gala.jamie, gala.lot(9));
  const { confirmed } = await startBidding(database, gala.jamie);
  const [plan] = await rows<{ confirmed_at: Date }>(pool, "select confirmed_at from glim_plans where id = $1", [confirmed.planId]);
  if (!plan) throw new Error("no plan");
  await scheduleReactions(pool);
  return { confirmedAt: plan.confirmed_at, planId: confirmed.planId };
}

const noBackground = (gala: DemoGala) => pool.query("delete from director_jobs where event_id = $1 and kind = 'bot_bid'", [gala.eventId]);

async function oneJob(gala: DemoGala, kind: string) {
  const [job] = await jobsOf(pool, gala.eventId, kind);
  if (!job) throw new Error(`no ${kind} job`);
  return job;
}

describe("the golden take", () => {
  it("runs from Start bidding to Glim's move with nobody tapping anything", async () => {
    const gala = await startGala(pool);
    const { confirmedAt } = await goldenPlan(gala);

    // Start bidding placed Glim's $90 on Spa Day; Chef's Table stays at Jamie's $320.
    expect((await lotRow(pool, gala.lot(12))).current_bid_cents).toBe(9_000);
    expect((await lotRow(pool, gala.lot(7))).current_bid_cents).toBe(32_000);

    const under = await oneJob(gala, "rival_under_limit");
    const over = await oneJob(gala, "rival_over_limit");
    const underDelay = under.run_at.getTime() - confirmedAt.getTime();
    expect(underDelay).toBeGreaterThanOrEqual(20_000);
    expect(underDelay).toBeLessThanOrEqual(40_000);
    expect(over.run_at.getTime()).toBeGreaterThan(under.run_at.getTime());
    expect(over.run_at.getTime()).toBeLessThan(gala.at(10, 30).getTime());

    // Nothing before its time.
    await runDueJobs({ pool, now: new Date(under.run_at.getTime() - 1) });
    expect((await lotRow(pool, gala.lot(7))).current_bid_cents).toBe(32_000);

    // $360, one raise under Glim's $380, and Glim answers in the same transaction.
    const [first] = (await runDueJobs({ pool, now: under.run_at })).filter((report) => report.kind === "rival_under_limit");
    expect(first?.result).toEqual({ outcome: "bid", paddleNumber: 88, lotNumber: 7, amountCents: 36_000, answeredWithCents: [38_000] });
    expect(await lotRow(pool, gala.lot(7))).toMatchObject({ current_bid_cents: 38_000, high_paddle_id: gala.jamie, high_bid_source: "glim" });

    // The next card the chat will show: "Someone bid $360. I raised to $380, your limit for this lot."
    const [raised] = await rows<{ payload: { kind: string; amountCents: number; limitCents: number; triggerAmountCents: number } }>(
      pool,
      "select payload from event_log where paddle_id = $1 and type = 'glim' and payload->>'kind' = 'limit_raised' order by id desc limit 1",
      [gala.jamie],
    );
    expect(raised?.payload).toMatchObject({ amountCents: 38_000, limitCents: 38_000, triggerAmountCents: 36_000 });

    // The background left Wine Tasting alone meanwhile, so Glim's opening bid will read $220.
    await walk(pool, under.run_at, new Date(over.run_at.getTime() - 1));
    expect((await lotRow(pool, gala.lot(9))).current_bid_cents).toBe(21_000);

    // $400 passes the limit, while Wine Tasting has at least 90 seconds left.
    const [second] = (await runDueJobs({ pool, now: over.run_at })).filter((report) => report.kind === "rival_over_limit");
    expect(second?.result).toEqual({ outcome: "bid", paddleNumber: 88, lotNumber: 7, amountCents: 40_000, answeredWithCents: [] });
    const chef = await lotRow(pool, gala.lot(7));
    expect(chef).toMatchObject({ current_bid_cents: 40_000, high_paddle_id: gala.paddle(88), high_bid_source: "bot" });

    // A simulated guest, labeled in the data, with a hold of at least $400.
    const [rival] = await rows<{ is_simulated: boolean; kind: string; amount_cents: number }>(
      pool,
      "select pd.is_simulated, h.kind, h.amount_cents from paddles pd join holds h on h.paddle_id = pd.id and h.status = 'authorized' where pd.id = $1",
      [gala.paddle(88)],
    );
    expect(rival).toEqual({ is_simulated: true, kind: "simulated", amount_cents: 50_000 });

    // Glim wakes on its own, and the recorded decision moves the money to Wine Tasting.
    expect(await scanFacts(pool)).toMatchObject({ triggers: 1 });
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("Glim did not wake");
    const decided = await runAutopilot(claim, { database, model: recordedModel });
    expect(decided).toMatchObject({ outcome: "applied", decidedBy: "model" });
    const [action] = await rows<{ message: string }>(pool, "select message from glim_actions where id = $1", [decided.actionId]);
    expect(action?.message).toBe("I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.");
    expect(await lotRow(pool, gala.lot(9))).toMatchObject({ current_bid_cents: 22_000, high_paddle_id: gala.jamie, high_bid_source: "glim" });

    // The rest of Wine Tasting's life: bots come in, Glim answers, and no bot passes $370.
    const lot9Closes = gala.at(12);
    await walk(pool, over.run_at, new Date(lot9Closes.getTime() - 6_000));
    const wineBots = await rows<{ amount_cents: number }>(
      pool,
      "select amount_cents from bids where lot_id = $1 and source = 'bot' and amount_cents > 21000 order by amount_cents",
      [gala.lot(9)],
    );
    expect(wineBots.length).toBeGreaterThan(0);
    expect(wineBots.every((bid) => bid.amount_cents <= 37_000)).toBe(true);
    expect(await lotRow(pool, gala.lot(9))).toMatchObject({ high_paddle_id: gala.jamie, high_bid_source: "glim" });
  });

  it("does not send the rivals twice, on a repeated scan or on a later plan", async () => {
    const gala = await startGala(pool);
    await goldenPlan(gala);
    expect(await scheduleReactions(pool)).toBe(0);
    const before = (await jobsOf(pool, gala.eventId)).length;

    await pool.query("update glim_plans set status = 'superseded', ended_at = now() where paddle_id = $1 and status = 'active'", [gala.jamie]);
    const { confirmed } = await startBidding(database, gala.jamie);
    expect(confirmed.ok).toBe(true);
    expect(await scheduleReactions(pool)).toBe(0);
    expect((await jobsOf(pool, gala.eventId)).length).toBe(before);
  });

  it("queues each rival once when two scans race", async () => {
    const gala = await startGala(pool);
    await giveHold(pool, gala, gala.jamie, 50_000);
    await bidByHand(pool, gala.jamie, gala.lot(7), 32_000);
    await startBidding(database, gala.jamie);
    const queued = await Promise.all([scheduleReactions(pool), scheduleReactions(pool), scheduleReactions(pool)]);
    expect(queued.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(await jobsOf(pool, gala.eventId, "rival_under_limit")).toHaveLength(1);
    expect(await jobsOf(pool, gala.eventId, "rival_over_limit")).toHaveLength(1);
  });

  it("gives an invited guest their own rivals", async () => {
    const gala = await startGala(pool);
    await goldenPlan(gala);
    const [invited] = await rows<{ id: string }>(
      pool,
      "insert into paddles (event_id, number, first_name, is_simulated) values ($1, 300, 'Kai', false) returning id",
      [gala.eventId],
    );
    if (!invited) throw new Error("no paddle");
    await giveHold(pool, gala, invited.id, 100_000);
    await bidByHand(pool, invited.id, gala.lot(2), 72_500);
    await bidByHand(pool, invited.id, gala.lot(5), 16_000);
    expect(await scheduleReactions(pool)).toBe(1);
    const jobs = await jobsOf(pool, gala.eventId, "rival_outbid");
    expect(jobs.map((job) => job.payload.guestPaddleId)).toEqual([invited.id]);
  });
});

describe("rival_over_limit", () => {
  async function pastTheFirstRival(gala: DemoGala, overRunsAt: Date): Promise<void> {
    await goldenPlan(gala);
    await noBackground(gala);
    const under = await oneJob(gala, "rival_under_limit");
    await runDueJobs({ pool, now: under.run_at });
    const over = await oneJob(gala, "rival_over_limit");
    await pool.query("update director_jobs set run_at = $2 where id = $1", [over.id, overRunsAt]);
  }

  it("fires at +10:29, with Wine Tasting's 91 seconds left", async () => {
    const gala = await startGala(pool);
    await pastTheFirstRival(gala, gala.at(10, 29));
    const [report] = await runDueJobs({ pool, now: gala.at(10, 29) });
    expect(report?.result).toMatchObject({ outcome: "bid", amountCents: 40_000 });
  });

  it("holds back at +10:31, and stays done", async () => {
    const gala = await startGala(pool);
    await pastTheFirstRival(gala, gala.at(10, 31));
    const [report] = await runDueJobs({ pool, now: gala.at(10, 31) });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "destination_closing" });
    expect((await lotRow(pool, gala.lot(7))).current_bid_cents).toBe(38_000);
    expect(await runDueJobs({ pool, now: gala.at(11) })).toEqual([]);
  });

  it("follows Wine Tasting's real close time, not the clock: Close next lot takes the beat away", async () => {
    const gala = await startGala(pool);
    await pastTheFirstRival(gala, gala.at(5));
    await pool.query("update lots set closes_at = $2 where id = $1", [gala.lot(9), gala.at(6, 20)]);
    const [report] = await runDueJobs({ pool, now: gala.at(5) });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "destination_closing" });
  });

  it("does nothing when the plan has moved on", async () => {
    const paused = await startGala(pool);
    await pastTheFirstRival(paused, paused.at(5));
    await pool.query("update glim_plans set status = 'paused' where paddle_id = $1 and status = 'active'", [paused.jamie]);
    expect((await runDueJobs({ pool, now: paused.at(5) }))[0]?.result).toEqual({ outcome: "skipped", reason: "no_running_plan" });

    const limitGone = await startGala(pool);
    await pastTheFirstRival(limitGone, limitGone.at(5));
    await pool.query("update bid_limits set active = false, ended_at = now() where paddle_id = $1 and lot_id = $2", [limitGone.jamie, limitGone.lot(7)]);
    expect((await runDueJobs({ pool, now: limitGone.at(5) }))[0]?.result).toEqual({ outcome: "skipped", reason: "no_limit_on_lot" });
  });
});

describe("rival_under_limit", () => {
  it("stands down when a rival could not bid under the limit", async () => {
    const gala = await startGala(pool);
    await goldenPlan(gala);
    await noBackground(gala);
    // Someone has already taken the lot to Glim's limit.
    await placeBid(gala.paddle(88), gala.lot(7), 36_000, "bot", { pool });
    const under = await oneJob(gala, "rival_under_limit");
    const [report] = await runDueJobs({ pool, now: under.run_at });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "no_room_under_limit" });
    expect((await lotRow(pool, gala.lot(7))).current_bid_cents).toBe(38_000);
  });

  it("leaves a lot about to close alone", async () => {
    const gala = await startGala(pool);
    await goldenPlan(gala);
    await noBackground(gala);
    const under = await oneJob(gala, "rival_under_limit");
    await pool.query("update lots set closes_at = $2 where id = $1", [gala.lot(7), new Date(under.run_at.getTime() + 4_000)]);
    const [report] = await runDueJobs({ pool, now: under.run_at });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "lot_closed" });
  });

  it("stays quiet on a demo where nobody has started a plan", async () => {
    const gala = await startGala(pool);
    await giveHold(pool, gala, gala.jamie, 50_000);
    await bidByHand(pool, gala.jamie, gala.lot(7), 32_000);
    await scheduleReactions(pool);
    expect(await jobsOf(pool, gala.eventId, "rival_under_limit")).toEqual([]);
    expect(await jobsOf(pool, gala.eventId, "rival_over_limit")).toEqual([]);
  });
});

describe("no director bid on Wine Tasting goes above $370", () => {
  it("holds for a rival chasing a guest there, and for a bot with a forged max", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 200_000);
    await bidByHand(pool, gala.jamie, gala.lot(2), 72_500);
    await bidByHand(pool, gala.jamie, gala.lot(9), 37_000);
    await scheduleReactions(pool);

    // Jamie leads Wine Tasting at $370, so the next bid would be $380.
    const outbid = await oneJob(gala, "rival_outbid");
    expect(outbid.payload.lotId).toBe(gala.lot(9));
    const [rival] = await runDueJobs({ pool, now: outbid.run_at });
    expect(rival?.result).toEqual({ outcome: "skipped", reason: "over_ceiling" });

    await insertJobs(pool, [
      {
        eventId: gala.eventId,
        kind: "bot_bid",
        runAt: gala.at(1),
        payload: { paddleId: gala.paddle(133), paddleNumber: 133, lotId: gala.lot(9), lotNumber: 9, maxCents: 100_000 },
      },
    ]);
    const [bot] = await runDueJobs({ pool, now: gala.at(1) });
    expect(bot?.result).toEqual({ outcome: "skipped", reason: "past_max" });
    expect(await lotRow(pool, gala.lot(9))).toMatchObject({ current_bid_cents: 37_000, high_paddle_id: gala.jamie });
  });

  it("holds for a plan with Wine Tasting first: the rival cannot play one raise under a $380 limit", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 100_000);
    // A plan row with Wine Tasting first and Glim's limit at $600 there.
    const [plan] = await rows<{ id: string }>(
      pool,
      `insert into glim_plans (paddle_id, status, budget_cents, proposal, confirmed_at)
       values ($1, 'active', 60000, '{}', now()) returning id`,
      [gala.jamie],
    );
    if (!plan) throw new Error("no plan");
    await pool.query(
      "insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, 1, 60000, 'watching')",
      [plan.id, gala.lot(9)],
    );
    const limit = await setMaxBid(gala.jamie, gala.lot(9), 60_000, { pool });
    expect(limit.ok).toBe(true);
    await pool.query("update bid_limits set owner = 'glim' where paddle_id = $1 and lot_id = $2", [gala.jamie, gala.lot(9)]);

    await scheduleReactions(pool);
    const under = await oneJob(gala, "rival_under_limit");
    const [report] = await runDueJobs({ pool, now: under.run_at });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "over_ceiling" });
  });
});

describe("rival_outbid", () => {
  it("comes 15 to 30 seconds after the guest's second manual lot, on that lot, and flips it", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 100_000);

    await bidByHand(pool, gala.jamie, gala.lot(2), 72_500);
    await scheduleReactions(pool);
    expect(await jobsOf(pool, gala.eventId, "rival_outbid")).toEqual([]);

    // A second bid on the first lot is not a second lot.
    await bidByHand(pool, gala.jamie, gala.lot(2), 75_000);
    await scheduleReactions(pool);
    expect(await jobsOf(pool, gala.eventId, "rival_outbid")).toEqual([]);

    await bidByHand(pool, gala.jamie, gala.lot(5), 16_000);
    expect(await scheduleReactions(pool)).toBe(1);
    const job = await oneJob(gala, "rival_outbid");
    expect(job.payload.lotId).toBe(gala.lot(5));
    const [bid] = await rows<{ created_at: Date }>(pool, "select created_at from bids where paddle_id = $1 and lot_id = $2", [gala.jamie, gala.lot(5)]);
    const delay = job.run_at.getTime() - (bid?.created_at.getTime() ?? 0);
    expect(delay).toBeGreaterThanOrEqual(15_000);
    expect(delay).toBeLessThanOrEqual(30_000);

    expect(await runDueJobs({ pool, now: new Date(job.run_at.getTime() - 1) })).toEqual([]);
    const [report] = await runDueJobs({ pool, now: job.run_at });
    // Hannah (151) wants the pottery up to $170.
    expect(report?.result).toEqual({ outcome: "bid", paddleNumber: 151, lotNumber: 5, amountCents: 17_000, answeredWithCents: [] });
    const lot = await lotRow(pool, gala.lot(5));
    expect(lot).toMatchObject({ current_bid_cents: 17_000, high_paddle_id: gala.paddle(151), high_bid_source: "bot" });
    const [outbid] = await rows<{ payload: { kind: string } }>(pool, "select payload from event_log where paddle_id = $1 and payload->>'kind' = 'outbid' and payload->>'lotNumber' = '5'", [gala.jamie]);
    expect(outbid?.payload.kind).toBe("outbid");

    // A third lot does not send anyone else.
    await bidByHand(pool, gala.jamie, gala.lot(11), 10_500);
    expect(await scheduleReactions(pool)).toBe(0);
  });

  it("stands down when the guest is no longer leading", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 100_000);
    await bidByHand(pool, gala.jamie, gala.lot(2), 72_500);
    await bidByHand(pool, gala.jamie, gala.lot(5), 16_000);
    await scheduleReactions(pool);
    await placeBid(gala.paddle(151), gala.lot(5), 17_000, "bot", { pool });
    const job = await oneJob(gala, "rival_outbid");
    const [report] = await runDueJobs({ pool, now: job.run_at });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "guest_not_leading" });
  });

  it("goes past a guest's own Max…, so the lot still flips", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 100_000);
    await bidByHand(pool, gala.jamie, gala.lot(2), 72_500);
    const max = await setMaxBid(gala.jamie, gala.lot(5), 18_000, { pool });
    expect(max.ok).toBe(true);
    await scheduleReactions(pool);
    const job = await oneJob(gala, "rival_outbid");
    const [report] = await runDueJobs({ pool, now: job.run_at });
    expect(report?.result).toMatchObject({ outcome: "bid", lotNumber: 5, amountCents: 19_000, answeredWithCents: [] });
    expect((await lotRow(pool, gala.lot(5))).high_paddle_id).not.toBe(gala.jamie);
  });

  it("finds someone with room, or does nothing", async () => {
    const gala = await startGala(pool);
    await noBackground(gala);
    await giveHold(pool, gala, gala.jamie, 500_000);
    await bidByHand(pool, gala.jamie, gala.lot(2), 72_500);
    // Nobody in the room can pay $3,000.
    await bidByHand(pool, gala.jamie, gala.lot(22), 300_000);
    await scheduleReactions(pool);
    const job = await oneJob(gala, "rival_outbid");
    const [report] = await runDueJobs({ pool, now: job.run_at });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "no_rival_with_room" });
    expect((await lotRow(pool, gala.lot(22))).high_paddle_id).toBe(gala.jamie);
  });
});

describe("the demos the director leaves alone", () => {
  it("reads only live demo galas", async () => {
    const closed = await startGala(pool);
    await giveHold(pool, closed, closed.jamie, 100_000);
    await bidByHand(pool, closed.jamie, closed.lot(2), 72_500);
    await bidByHand(pool, closed.jamie, closed.lot(5), 16_000);
    await pool.query("update events set status = 'closed' where id = $1", [closed.eventId]);
    await scheduleReactions(pool);
    expect(await jobsOf(pool, closed.eventId, "rival_outbid")).toEqual([]);

    const notDemo = await startGala(pool);
    await giveHold(pool, notDemo, notDemo.jamie, 100_000);
    await bidByHand(pool, notDemo.jamie, notDemo.lot(2), 72_500);
    await bidByHand(pool, notDemo.jamie, notDemo.lot(5), 16_000);
    await pool.query("update events set is_demo = false where id = $1", [notDemo.eventId]);
    await scheduleReactions(pool);
    expect(await jobsOf(pool, notDemo.eventId, "rival_outbid")).toEqual([]);
  });
});
