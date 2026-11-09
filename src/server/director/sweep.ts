/**
 * What the cron job runs every 15 minutes (POST /api/cron/sweep): expired holds, retried voids of
 * replaced holds, the 6-hour demo cleanup, old rate-limit windows, old error_log rows and a heartbeat. Running it twice
 * does nothing the first run did not: every step reads what is still owed, and every PayPal call
 * repeats its request id. One step's failure does not stop the others.
 */
import type pg from "pg";

import { pruneRateLimits } from "@/server/api/rate-limit";
import { getPool } from "@/server/db/client";
import { withTransaction } from "@/server/db/transaction";
import { getPayments } from "@/server/paypal/runtime";

import { endHold, liveAuthorizationsOf, releaseAuthorization, replacedAuthorizations, type ReleaseDependencies } from "./holds";
import { retireDemo } from "./retire";

export const SWEEP_HEARTBEAT = "sweep";
/** Advisory-lock key (see engine/locks.ts): two sweeps at once would only waste PayPal calls. */
export const SWEEP_LOCK = { namespace: 0x4648_0006, key: 1 } as const;
/** Each step's work per run; anything left waits for the next sweep. */
const BATCH_SIZE = 200;
const DEMOS_PER_SWEEP = 50;
/** A delete waits this long for a row in use, then tries again next sweep. */
const DELETE_LOCK_TIMEOUT = "10s";
/** Well past Render's 7 days of logs, which is why error_log exists, on a 1 GB database. */
const ERROR_LOG_DAYS = 30;

export interface SweepReport {
  /** False when another sweep held the lock. */
  ran: boolean;
  holdsExpired: number;
  replacedVoided: number;
  voidsFailed: number;
  demosDeleted: number;
  /** Past their 6 hours, and still owed a void or waiting on a settlement. */
  demosWaiting: number;
  rateLimitsPruned: number;
  errorLogPruned: number;
  /** The steps that threw. */
  errors: string[];
}

export type SweepOptions = Partial<ReleaseDependencies>;

async function logStepFailure(pool: pg.Pool, step: string, error: unknown, eventId: string | null = null): Promise<void> {
  console.error(`[sweep] ${step} failed:`, error);
  const message = error instanceof Error ? error.message : String(error);
  await pool
    .query("insert into error_log (source, code, message, event_id, detail) values ('cron', 'sweep_step_failed', $1, $2, $3::jsonb)", [
      message,
      eventId,
      JSON.stringify({ step }),
    ])
    .catch((logFailure: unknown) => console.error("[sweep] could not write error_log:", logFailure));
}

async function expireHolds({ pool }: ReleaseDependencies, report: SweepReport): Promise<void> {
  const { rows } = await pool.query<{ id: string; paddle_id: string }>(
    `select id, paddle_id from holds where status in ('authorized', 'replaced') and expires_at <= now()
     order by expires_at limit $1`,
    [BATCH_SIZE],
  );
  for (const row of rows) {
    if (await endHold(pool, { id: row.id, paddleId: row.paddle_id }, "expired", { onlyIfExpired: true })) report.holdsExpired += 1;
  }
}

async function retryReplacedVoids(dependencies: ReleaseDependencies, report: SweepReport): Promise<void> {
  for (const hold of await replacedAuthorizations(dependencies.pool, BATCH_SIZE)) {
    const outcome = await releaseAuthorization(hold, dependencies);
    if (outcome === "released") report.replacedVoided += 1;
    else report.voidsFailed += 1;
  }
}

async function deleteDemo(pool: pg.Pool, eventId: string): Promise<void> {
  // Every table hangs off events with on delete cascade.
  await withTransaction(pool, async (client) => {
    await client.query(`set local lock_timeout = '${DELETE_LOCK_TIMEOUT}'`);
    await client.query("delete from events where id = $1 and is_demo", [eventId]);
  });
}

/** One expired demo: closed, then every real authorization voided, and only then deleted. */
async function cleanUpDemo(eventId: string, dependencies: ReleaseDependencies, report: SweepReport): Promise<void> {
  const { pool } = dependencies;
  if ((await retireDemo(pool, eventId)) === "settlement_running") {
    report.demosWaiting += 1;
    return;
  }
  let released = true;
  for (const hold of await liveAuthorizationsOf(pool, eventId)) {
    if ((await releaseAuthorization(hold, dependencies)) === "failed") {
      released = false;
      report.voidsFailed += 1;
    }
  }
  if (!released) {
    report.demosWaiting += 1;
    return;
  }
  await deleteDemo(pool, eventId);
  report.demosDeleted += 1;
}

async function cleanUpExpiredDemos(dependencies: ReleaseDependencies, report: SweepReport): Promise<void> {
  const { rows } = await dependencies.pool.query<{ id: string }>(
    "select id from events where is_demo and demo_expires_at <= now() order by demo_expires_at limit $1",
    [DEMOS_PER_SWEEP],
  );
  for (const { id } of rows) {
    // One demo that cannot go yet (a row in use, say) must not hold back the others.
    try {
      await cleanUpDemo(id, dependencies, report);
    } catch (error) {
      report.demosWaiting += 1;
      await logStepFailure(dependencies.pool, "clean_up_demo", error, id);
    }
  }
}

async function writeHeartbeat(pool: pg.Pool, report: SweepReport): Promise<void> {
  await pool.query(
    `insert into heartbeats (name, beat_at, detail) values ($1, now(), $2::jsonb)
     on conflict (name) do update set beat_at = excluded.beat_at, detail = excluded.detail`,
    [SWEEP_HEARTBEAT, JSON.stringify(report)],
  );
}

export async function runSweep(options: SweepOptions = {}): Promise<SweepReport> {
  const dependencies: ReleaseDependencies = {
    pool: options.pool ?? getPool(),
    paymentsFor: options.paymentsFor ?? getPayments,
  };
  const { pool } = dependencies;
  const report: SweepReport = {
    ran: true,
    holdsExpired: 0,
    replacedVoided: 0,
    voidsFailed: 0,
    demosDeleted: 0,
    demosWaiting: 0,
    rateLimitsPruned: 0,
    errorLogPruned: 0,
    errors: [],
  };

  const lockHolder = await pool.connect();
  // A connection that kept the session lock must not go back to the pool.
  let lockStuck = false;
  try {
    const { rows } = await lockHolder.query<{ acquired: boolean }>("select pg_try_advisory_lock($1, $2) as acquired", [
      SWEEP_LOCK.namespace,
      SWEEP_LOCK.key,
    ]);
    if (!rows[0]?.acquired) return { ...report, ran: false };

    try {
      const steps: readonly (readonly [string, () => Promise<unknown>])[] = [
        // Expiry first: an expired authorization has nothing left to void.
        ["expire_holds", () => expireHolds(dependencies, report)],
        ["retry_replaced_voids", () => retryReplacedVoids(dependencies, report)],
        ["clean_up_demos", () => cleanUpExpiredDemos(dependencies, report)],
        [
          "prune_rate_limits",
          async () => {
            report.rateLimitsPruned = await pruneRateLimits(pool);
          },
        ],
        [
          "prune_error_log",
          async () => {
            const { rowCount } = await pool.query("delete from error_log where created_at < now() - make_interval(days => $1)", [ERROR_LOG_DAYS]);
            report.errorLogPruned = rowCount ?? 0;
          },
        ],
      ];
      for (const [step, run] of steps) {
        try {
          await run();
        } catch (error) {
          report.errors.push(step);
          await logStepFailure(pool, step, error);
        }
      }
      await writeHeartbeat(pool, report);
    } finally {
      await lockHolder.query("select pg_advisory_unlock($1, $2)", [SWEEP_LOCK.namespace, SWEEP_LOCK.key]).catch(() => {
        lockStuck = true;
      });
    }
    return report;
  } finally {
    lockHolder.release(lockStuck);
  }
}
