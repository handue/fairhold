import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { createTransactionStore, ENGINE_TRANSACTION_BEGIN } from "@/server/engine/pg-store";
import type { EngineStore } from "@/server/engine/store";

const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 3;

function sqlState(error: unknown): string {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

export interface DirectorTx {
  client: pg.PoolClient;
  /** The engine's actions run inside this transaction through it. */
  store: EngineStore;
}

/** One transaction begun as the engine's are, with their lock timeouts, and retried as theirs are. */
export async function withDirectorTransaction<T>(pool: pg.Pool, work: (tx: DirectorTx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const client = await pool.connect();
    let broken = false;
    try {
      await client.query(ENGINE_TRANSACTION_BEGIN);
      const result = await work({ client, store: createTransactionStore(client) });
      await client.query("commit");
      return result;
    } catch (error) {
      broken = !(await client.query("rollback").then(
        () => true,
        () => false,
      ));
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
