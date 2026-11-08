import type pg from "pg";

import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { withTransaction } from "@/server/db/transaction";
import { createPostgresHoldStore, type HoldStore } from "@/server/paypal/hold-store";
import type { HoldKind, Payments } from "@/server/paypal/payments";
import { getPayments } from "@/server/paypal/runtime";

/** Everything settlement reaches outside itself; a test swaps PayPal or the pool. */
export interface SettlementDependencies {
  pool: pg.Pool;
  paymentsFor: (kind: HoldKind) => Payments;
  /** Only for reading PayPal's times against; due dates in SQL use the database clock. */
  now: () => Date;
  holdStore: Pick<HoldStore, "markReplacedVoided" | "recordPaypalError">;
}

export function resolveDependencies(overrides: Partial<SettlementDependencies> = {}): SettlementDependencies {
  return {
    pool: overrides.pool ?? getPool(),
    paymentsFor: overrides.paymentsFor ?? getPayments,
    now: overrides.now ?? (() => new Date()),
    holdStore: overrides.holdStore ?? createPostgresHoldStore(),
  };
}

/**
 * One transaction of settlement. Lock order, extending the engine's (src/server/engine/store.ts) so
 * neither can deadlock the other: paddle rows, their hold rows, settlement items, the settlement,
 * the event row, then the event_log ordering lock as the last write.
 */
export function settlementTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, async (client) => {
    await client.query("set local lock_timeout = '5s'");
    await client.query("set local statement_timeout = '15s'");
    return work(client);
  });
}

/** Render keeps logs for 7 days and the demo runs longer, so failures also go to error_log. */
export async function logSettlementError(
  db: Queryable,
  entry: {
    code: string;
    message: string;
    eventId?: string | null;
    paddleId?: string | null;
    debugId?: string | null;
    detail?: unknown;
    source?: "settlement" | "webhook";
  },
): Promise<void> {
  console.error(`[${entry.source ?? "settlement"}] ${entry.code}: ${entry.message}`);
  await db
    .query(
      `insert into error_log (source, code, message, event_id, paddle_id, paypal_debug_id, detail)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        entry.source ?? "settlement",
        entry.code,
        entry.message,
        entry.eventId ?? null,
        entry.paddleId ?? null,
        entry.debugId ?? null,
        JSON.stringify(entry.detail ?? null),
      ],
    )
    .catch((error: unknown) => console.error("[settlement] could not write error_log:", error));
}
