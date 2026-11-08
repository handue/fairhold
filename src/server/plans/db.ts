/**
 * Small database pieces the plan writer and the autopilot runtime share: the transaction wrapper
 * with the engine's retry policy, the rows every run writes, and the error log.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { createTransactionStore, ENGINE_TRANSACTION_BEGIN } from "@/server/engine/pg-store";
import type { EngineStore } from "@/server/engine/store";

export type Queryable = Pick<pg.ClientBase, "query">;

export interface PlanTx {
  client: pg.PoolClient;
  /** The engine's actions run inside this transaction through it. */
  store: EngineStore;
  attempt: number;
}

/** Thrown inside withPlanTransaction to roll back and return `value` instead of committing. */
export class PlanAbort<T> extends Error {
  constructor(readonly value: T) {
    super("plan transaction rolled back");
  }
}

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 3;

export function sqlState(error: unknown): string {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

/**
 * The one transaction shape that writes Glim plans (docs/planning/glim-autopilot.md §5.2): it
 * begins as the engine's do, runs `work`, and commits. A PlanAbort rolls back and returns its
 * value. Deadlocks and serialization failures retry the whole transaction up to three times with
 * jitter, the engine's policy, so every check inside runs again on each attempt.
 */
export async function withPlanTransaction<T>(pool: pg.Pool, work: (tx: PlanTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(ENGINE_TRANSACTION_BEGIN);
      const result = await work({ client, store: createTransactionStore(client), attempt });
      await client.query("commit");
      return result;
    } catch (error) {
      broken = !(await rollbackQuietly(client));
      if (error instanceof PlanAbort) return error.value as T;
      if (attempt < MAX_ATTEMPTS && RETRYABLE_SQLSTATES.has(sqlState(error))) {
        await sleep(10 * attempt + Math.floor(Math.random() * 10));
        continue;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

async function rollbackQuietly(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query("rollback");
    return true;
  } catch {
    return false;
  }
}

/** Keeps a failure past Render's log retention (error_log), never throwing itself. */
export async function logError(
  db: Queryable,
  entry: { code: string; message: string; eventId?: string | null; paddleId?: string | null; detail?: unknown },
): Promise<void> {
  try {
    await db.query(
      `insert into error_log (source, code, message, event_id, paddle_id, detail)
       values ('glim', $1, $2, $3, $4, $5::jsonb)`,
      [entry.code, entry.message, entry.eventId ?? null, entry.paddleId ?? null, JSON.stringify(entry.detail ?? null)],
    );
  } catch (error) {
    console.error("[glim autopilot] could not write error_log:", error);
  }
}
