/**
 * The job runner. A job is claimed with FOR UPDATE SKIP LOCKED and runs in that same transaction,
 * through the engine's store, so its bid and its "done" commit together: a crash at any point rolls
 * both back and leaves the job queued, and a restart can never place one job's bid twice. The row
 * lock is the lease, so `running` is never stored. Job rows lock before lots, and no transaction
 * holding a lot lock ever touches a job row, so this adds no deadlock to the engine's lock order.
 */
import type pg from "pg";

import { getPool } from "@/server/db/client";
import { nextMinimumCents } from "@/server/engine/rules";
import type { EngineStore } from "@/server/engine/store";

import { lockLot, lotUnavailable, placeDirectorBid, skipped, type JobResult } from "./bids";
import { withDirectorTransaction } from "./db";
import { botBidPayload, DIRECTOR_JOB_KINDS, rivalOfPlanPayload, rivalOutbidPayload, type DirectorJobKind } from "./jobs";
import { runRivalOutbid, runRivalOverLimit, runRivalUnderLimit } from "./rivals";
import { directorCeilingCents, STALE_BOT_BID_MS } from "./rules";

export const MAX_JOB_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;
const LAST_ERROR_LENGTH = 500;

export interface ClaimedJob {
  id: string;
  eventId: string;
  kind: string;
  payload: unknown;
  runAt: Date;
  attempts: number;
}

export interface JobContext {
  client: pg.PoolClient;
  store: EngineStore;
  job: ClaimedJob;
  /** The clock this job decides by: the database's, or the caller's in a test. */
  now: Date;
}

export interface RunOptions {
  pool?: pg.Pool;
  /** A controllable clock for tests. Bids are still refused by the engine on the database clock. */
  now?: Date;
}

export interface JobReport {
  jobId: string;
  kind: string;
  eventId: string;
  status: "done" | "retrying" | "failed";
  result: JobResult | null;
}

type ClaimRow = {
  id: string;
  event_id: string;
  kind: string;
  payload: unknown;
  run_at: Date;
  attempts: number;
  clock: Date;
};

async function claimDueJob(client: pg.PoolClient, now: Date | null): Promise<{ job: ClaimedJob; clock: Date } | null> {
  // now(), not clock_timestamp(), in the condition: a stable value lets the partial due index answer it.
  const { rows } = await client.query<ClaimRow>(
    `select id, event_id, kind, payload, run_at, attempts, coalesce($1::timestamptz, clock_timestamp()) as clock
     from director_jobs
     where status = 'queued' and run_at <= coalesce($1::timestamptz, now())
     order by run_at, id
     limit 1
     for update skip locked`,
    [now],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    job: { id: row.id, eventId: row.event_id, kind: row.kind, payload: row.payload, runAt: row.run_at, attempts: row.attempts },
    clock: row.clock,
  };
}

async function runBotBid(context: JobContext): Promise<JobResult> {
  const { client, job, now } = context;
  const payload = botBidPayload.parse(job.payload);
  if (now.getTime() - job.runAt.getTime() > STALE_BOT_BID_MS) return skipped("stale");

  const lot = await lockLot(client, payload.lotId);
  if (!lot || lot.eventId !== job.eventId) return skipped("lot_closed");
  const unavailable = lotUnavailable(lot, now);
  if (unavailable) return skipped(unavailable);
  if (lot.highPaddleId === payload.paddleId) return skipped("already_leading");

  const amountCents = nextMinimumCents(lot);
  if (amountCents > Math.min(payload.maxCents, directorCeilingCents(lot.number))) return skipped("past_max");
  return placeDirectorBid(context, payload.paddleId, lot, amountCents);
}

function isJobKind(kind: string): kind is DirectorJobKind {
  return (DIRECTOR_JOB_KINDS as readonly string[]).includes(kind);
}

async function execute(context: JobContext): Promise<JobResult> {
  const { kind, payload } = context.job;
  if (!isJobKind(kind)) throw new Error(`Unknown director job kind ${kind}`);
  switch (kind) {
    case "bot_bid":
      return runBotBid(context);
    case "rival_under_limit":
      return runRivalUnderLimit(context, rivalOfPlanPayload.parse(payload));
    case "rival_over_limit":
      return runRivalOverLimit(context, rivalOfPlanPayload.parse(payload));
    case "rival_outbid":
      return runRivalOutbid(context, rivalOutbidPayload.parse(payload));
  }
}

async function recordFailure(pool: pg.Pool, job: ClaimedJob, error: unknown, now: Date | null): Promise<"retrying" | "failed"> {
  const attempts = job.attempts + 1;
  const giveUp = attempts >= MAX_JOB_ATTEMPTS;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, LAST_ERROR_LENGTH);
  await pool.query(
    `update director_jobs set
       attempts = $2,
       last_error = $3,
       status = case when $4::boolean then 'failed'::director_job_status else 'queued'::director_job_status end,
       completed_at = case when $4::boolean then clock_timestamp() end,
       run_at = case when $4::boolean then run_at
         else coalesce($5::timestamptz, clock_timestamp()) + make_interval(secs => $6::float8) end
     where id = $1`,
    [job.id, attempts, message, giveUp, now, (RETRY_DELAY_MS * attempts) / 1_000],
  );
  if (giveUp) {
    await pool.query(
      "insert into error_log (source, code, message, event_id, detail) values ('director', 'job_failed', $1, $2, $3::jsonb)",
      [message, job.eventId, JSON.stringify({ jobId: job.id, kind: job.kind })],
    );
  }
  return giveUp ? "failed" : "retrying";
}

/** Runs the oldest due job, if there is one. A job that throws is retried later, never in this call. */
export async function runNextJob({ pool = getPool(), now }: RunOptions = {}): Promise<JobReport | null> {
  let claimed: ClaimedJob | null = null;
  try {
    return await withDirectorTransaction(pool, async ({ client, store }) => {
      const claim = await claimDueJob(client, now ?? null);
      claimed = claim?.job ?? null;
      if (!claim) return null;
      const result = await execute({ client, store, job: claim.job, now: claim.clock });
      await client.query(
        `update director_jobs set status = 'done', attempts = attempts + 1, completed_at = clock_timestamp(),
           last_error = null, payload = payload || jsonb_build_object('result', $2::jsonb)
         where id = $1`,
        [claim.job.id, JSON.stringify(result)],
      );
      return { jobId: claim.job.id, kind: claim.job.kind, eventId: claim.job.eventId, status: "done" as const, result };
    });
  } catch (error) {
    const job = claimed as ClaimedJob | null;
    if (!job) throw error;
    const status = await recordFailure(pool, job, error, now ?? null);
    return { jobId: job.id, kind: job.kind, eventId: job.eventId, status, result: null };
  }
}

/** Runs every due job, one after another. The tick uses runNextJob; tests use this. */
export async function runDueJobs(options: RunOptions & { limit?: number } = {}): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  const limit = options.limit ?? 1_000;
  while (reports.length < limit) {
    const report = await runNextJob(options);
    if (!report) break;
    reports.push(report);
  }
  return reports;
}

/** How many jobs are due, up to `limit`: the one query an idle tick spends on the queue. */
export async function dueJobCount(pool: pg.Pool, limit: number): Promise<number> {
  const { rows } = await pool.query<{ due: number }>(
    `select count(*)::int as due from (
       select 1 from director_jobs where status = 'queued' and run_at <= now() limit $1
     ) jobs`,
    [limit],
  );
  return rows[0]?.due ?? 0;
}
