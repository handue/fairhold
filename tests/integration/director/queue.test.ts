/** The job runner: claimed with SKIP LOCKED, one bid per job, safe across crashes and restarts. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertJobs } from "@/server/director/jobs";
import { MAX_JOB_ATTEMPTS, runDueJobs, runNextJob } from "@/server/director/run";
import { createDirectorTickTask } from "@/server/director/task";
import { createEngineTick, type EngineTick } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";

import { jobsOf, lotRow, rows, startGala, type DemoGala } from "./support";

const database = getTestDatabase();
const { pool, url } = database;

/** A demo with no background script, so each test sees only its own jobs. */
async function emptyGala(): Promise<DemoGala> {
  const gala = await startGala(pool);
  await pool.query("delete from director_jobs where event_id = $1", [gala.eventId]);
  return gala;
}

async function queueBid(gala: DemoGala, paddle: number, lot: number, runAt: Date, maxCents = 1_000_000): Promise<void> {
  await insertJobs(pool, [
    {
      eventId: gala.eventId,
      kind: "bot_bid",
      runAt,
      payload: { paddleId: gala.paddle(paddle), paddleNumber: paddle, lotId: gala.lot(lot), lotNumber: lot, maxCents },
    },
  ]);
}

const ticks: EngineTick[] = [];
beforeEach(async () => {
  await pool.query("delete from events");
});
afterEach(async () => {
  await Promise.all(ticks.splice(0).map((tick) => tick.stop()));
});

describe("the director's queue", () => {
  it("places a due job's bid through the engine, as a bot, and marks it done", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, gala.at(0, 30));
    const [report] = await runDueJobs({ pool, now: gala.at(0, 31) });
    expect(report).toMatchObject({ kind: "bot_bid", status: "done", result: { outcome: "bid", paddleNumber: 168, lotNumber: 2 } });

    const lot = await lotRow(pool, gala.lot(2));
    expect(lot).toMatchObject({ high_paddle_id: gala.paddle(168), high_bid_source: "bot" });
    const [job] = await jobsOf(pool, gala.eventId);
    expect(job).toMatchObject({ status: "done", attempts: 1, last_error: null, payload: { result: { outcome: "bid" } } });
    expect(job?.completed_at).not.toBeNull();
  });

  it("does not run a job before its time", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, gala.at(1));
    expect(await runDueJobs({ pool, now: gala.at(0, 59) })).toEqual([]);
    expect((await jobsOf(pool, gala.eventId))[0]?.status).toBe("queued");
    expect(await runDueJobs({ pool, now: gala.at(1) })).toHaveLength(1);
    expect(await runDueJobs({ pool, now: gala.at(2) })).toEqual([]);
  });

  it("never runs a job twice when runners compete, and each takes a different job", async () => {
    const gala = await emptyGala();
    const lots = [1, 2, 3, 4, 5, 6, 8, 10, 11, 13];
    for (const lot of lots) await queueBid(gala, 165, lot, gala.at(0, 10));
    const started = await rows<{ n: number }>(pool, "select count(*)::int as n from bids b join lots l on l.id = b.lot_id where l.event_id = $1", [gala.eventId]);

    const reports = (await Promise.all([1, 2, 3, 4].map(() => runDueJobs({ pool, now: gala.at(0, 11) })))).flat();
    expect(new Set(reports.map((report) => report.jobId)).size).toBe(lots.length);
    expect(reports).toHaveLength(lots.length);
    expect((await jobsOf(pool, gala.eventId)).every((job) => job.status === "done" && job.attempts === 1)).toBe(true);
    const ended = await rows<{ n: number }>(pool, "select count(*)::int as n from bids b join lots l on l.id = b.lot_id where l.event_id = $1", [gala.eventId]);
    const placed = reports.filter((report) => report.result?.outcome === "bid").length;
    expect((ended[0]?.n ?? 0) - (started[0]?.n ?? 0)).toBe(placed);
  });

  it("skips a job another runner holds, and runs it once that runner is gone", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, gala.at(0, 10));
    await queueBid(gala, 165, 4, gala.at(0, 20));

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      const { rows: held } = await holder.query<{ id: string }>(
        "select id from director_jobs where event_id = $1 order by run_at limit 1 for update",
        [gala.eventId],
      );
      const reports = await runDueJobs({ pool, now: gala.at(0, 30) });
      expect(reports.map((report) => report.jobId)).not.toContain(held[0]?.id);
      expect(reports).toHaveLength(1);
      // The runner died: its transaction rolls back and the job is still there to run.
      await holder.query("rollback");
    } finally {
      holder.release();
    }
    expect(await runDueJobs({ pool, now: gala.at(0, 30) })).toHaveLength(1);
    expect((await jobsOf(pool, gala.eventId)).map((job) => job.status)).toEqual(["done", "done"]);
  });

  it("commits a job's bid and its done together: a crash before commit leaves no bid and the job queued", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, gala.at(0, 10));
    const before = await lotRow(pool, gala.lot(2));

    // The last statement of the job's transaction fails, after the engine has written its bid.
    await pool.query(`
      create function refuse_done() returns trigger language plpgsql as $$
      begin
        if new.status = 'done' then raise exception 'the process died here'; end if;
        return new;
      end $$`);
    await pool.query("create trigger refuse_done before update on director_jobs for each row execute function refuse_done()");
    try {
      const report = await runNextJob({ pool, now: gala.at(0, 11) });
      expect(report).toMatchObject({ status: "retrying", result: null });
      expect(await lotRow(pool, gala.lot(2))).toEqual(before);
      const [job] = await jobsOf(pool, gala.eventId);
      expect(job).toMatchObject({ status: "queued", attempts: 1, last_error: "the process died here" });
      expect(job?.run_at.getTime()).toBe(gala.at(0, 16).getTime());
    } finally {
      await pool.query("drop trigger refuse_done on director_jobs; drop function refuse_done()");
    }

    // After the restart it runs once, and there is exactly one new bid.
    const reports = await runDueJobs({ pool, now: gala.at(0, 20) });
    expect(reports).toMatchObject([{ status: "done", result: { outcome: "bid" } }]);
    expect((await lotRow(pool, gala.lot(2))).bid_count).toBe(before.bid_count + 1);
    expect(await runDueJobs({ pool, now: gala.at(0, 30) })).toEqual([]);
  });

  it("retries a job that throws, gives up after three attempts, and keeps the failure", async () => {
    const gala = await emptyGala();
    await pool.query(
      "insert into director_jobs (event_id, kind, payload, run_at) values ($1, 'bot_bid', '{\"nonsense\":true}', $2)",
      [gala.eventId, gala.at(0, 1)],
    );
    const statuses: (string | undefined)[] = [];
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt += 1) {
      const report = await runNextJob({ pool, now: gala.at(attempt) });
      statuses.push(report?.status);
    }
    expect(statuses).toEqual(["retrying", "retrying", "failed"]);
    const [job] = await jobsOf(pool, gala.eventId);
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
    expect(job?.last_error).toBeTruthy();
    expect(await runNextJob({ pool, now: gala.at(30) })).toBeNull();
    const logged = await rows<{ source: string; code: string }>(pool, "select source, code from error_log where event_id = $1", [gala.eventId]);
    expect(logged).toEqual([{ source: "director", code: "job_failed" }]);
  });

  it("fails a job of an unknown kind without stopping the ones behind it", async () => {
    const gala = await emptyGala();
    await pool.query("insert into director_jobs (event_id, kind, run_at) values ($1, 'rival_from_the_future', $2)", [gala.eventId, gala.at(0, 1)]);
    await queueBid(gala, 168, 2, gala.at(0, 2));
    const reports = await runDueJobs({ pool, now: gala.at(0, 3) });
    expect(reports.map((report) => report.status)).toEqual(["retrying", "done"]);
  });

  it("drops a background bid that comes more than two minutes late, so a restart brings no burst", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, gala.at(1));
    const before = await lotRow(pool, gala.lot(2));
    const [report] = await runDueJobs({ pool, now: gala.at(3, 1) });
    expect(report?.result).toEqual({ outcome: "skipped", reason: "stale" });
    expect(await lotRow(pool, gala.lot(2))).toEqual(before);
  });

  it("does not make the tick wait for a job stuck behind a lot lock", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, new Date(Date.now() - 1_000));
    const errors: unknown[] = [];
    const task = createDirectorTickTask({ database, onError: (error) => errors.push(error) });

    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from lots where id = $1 for update", [gala.lot(2)]);
      // The round is over while the job still waits behind the lock this test holds.
      await task.run();
      expect((await jobsOf(pool, gala.eventId))[0]?.status).toBe("queued");
      await holder.query("rollback");
    } finally {
      holder.release();
    }
    await task.idle();
    expect((await jobsOf(pool, gala.eventId))[0]).toMatchObject({ status: "done", payload: { result: { outcome: "bid" } } });
    expect(errors).toEqual([]);
  });

  it("runs from the engine tick as one of its extra tasks", async () => {
    const gala = await emptyGala();
    await queueBid(gala, 168, 2, new Date(Date.now() - 1_000));
    const errors: unknown[] = [];
    const task = createDirectorTickTask({ database, onError: (error) => errors.push(error) });
    ticks.push(createEngineTick({ intervalMs: 25, connectionString: url, tasks: [task], onError: (error) => errors.push(error) }));
    await expect.poll(async () => (await jobsOf(pool, gala.eventId))[0]?.status, { timeout: 15_000 }).toBe("done");
    await ticks.pop()?.stop();
    await task.idle();
    expect(errors).toEqual([]);
  });

  it("uses no more workers than it is given, however many jobs are due", async () => {
    const gala = await emptyGala();
    for (const lot of [1, 2, 3, 4, 5, 6, 8, 10]) await queueBid(gala, 165, lot, new Date(Date.now() - 1_000));
    const task = createDirectorTickTask({ database, maxWorkers: 1 });
    await task.run();
    await task.run();
    await task.idle();
    const done = (await jobsOf(pool, gala.eventId)).filter((job) => job.status === "done").length;
    expect(done).toBeGreaterThan(0);
    expect(done).toBeLessThanOrEqual(10);
  });
});
