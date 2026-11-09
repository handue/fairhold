/**
 * Releasing authorizations the demo no longer needs. The void itself goes through the payments
 * interface (src/server/paypal), on the original authorization id, with the same PayPal-Request-Id
 * on every retry, so a retry after a crash replays the first answer. The paddle row is locked before
 * a hold's status changes (src/server/engine/store.ts), and never across the PayPal call.
 * Simulated guests' holds have no authorization and are never read here: they never call PayPal.
 */
import type pg from "pg";

import type { Queryable } from "@/server/db/transaction";
import { PaypalError } from "@/server/paypal/errors";
import type { HoldStatus } from "@/server/paypal/hold-store";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { HoldKind, Payments } from "@/server/paypal/payments";
import { appendEventLog } from "@/server/sse/notify";

import { withDirectorTransaction } from "./db";

export interface LiveAuthorization {
  id: string;
  eventId: string;
  paddleId: string;
  kind: HoldKind;
  originalAuthorizationId: string;
}

export interface ReleaseDependencies {
  pool: pg.Pool;
  paymentsFor: (kind: HoldKind) => Payments;
}

type AuthorizationRow = {
  id: string;
  event_id: string;
  paddle_id: string;
  kind: HoldKind;
  original_authorization_id: string;
};

const toLive = (row: AuthorizationRow): LiveAuthorization => ({
  id: row.id,
  eventId: row.event_id,
  paddleId: row.paddle_id,
  kind: row.kind,
  originalAuthorizationId: row.original_authorization_id,
});

const LIVE_AUTHORIZATION_COLUMNS = "h.id, h.event_id, h.paddle_id, h.kind, h.original_authorization_id";

/** A demo's real authorizations that may still be live: its bidding power, and any replaced hold. */
export async function liveAuthorizationsOf(db: Queryable, eventId: string): Promise<LiveAuthorization[]> {
  const { rows } = await db.query<AuthorizationRow>(
    `select ${LIVE_AUTHORIZATION_COLUMNS}
     from holds h join paddles pd on pd.id = h.paddle_id and not pd.is_simulated
     where h.event_id = $1 and h.status in ('authorized', 'replaced') and h.original_authorization_id is not null
     order by h.created_at, h.id`,
    [eventId],
  );
  return rows.map(toLive);
}

/**
 * Replaced holds still holding an authorization, on events the demo cleanup is not about to handle:
 * a refused approval, or a raise whose void failed (docs/status/day1.md).
 */
export async function replacedAuthorizations(db: Queryable, limit: number): Promise<LiveAuthorization[]> {
  const { rows } = await db.query<AuthorizationRow>(
    `select ${LIVE_AUTHORIZATION_COLUMNS}
     from holds h
     join paddles pd on pd.id = h.paddle_id and not pd.is_simulated
     join events e on e.id = h.event_id
     where h.status = 'replaced' and h.original_authorization_id is not null
       and not (e.is_demo and e.demo_expires_at <= now())
     order by h.created_at, h.id
     limit $1`,
    [limit],
  );
  return rows.map(toLive);
}

/**
 * Moves a hold out of authorized or replaced, under the paddle row lock, with its row on the paddle's
 * channel. Returns false when another writer moved it first.
 */
export async function endHold(
  pool: pg.Pool,
  hold: { id: string; paddleId: string },
  status: Extract<HoldStatus, "voided" | "expired" | "captured">,
  { onlyIfExpired = false }: { onlyIfExpired?: boolean } = {},
): Promise<boolean> {
  return withDirectorTransaction(pool, async ({ client }) => {
    await client.query("select id from paddles where id = $1 for no key update", [hold.paddleId]);
    const { rows } = await client.query<{ event_id: string; paddle_id: string }>(
      `update holds set status = $2, last_synced_at = now()
       where id = $1 and status in ('authorized', 'replaced') and (not $3 or expires_at <= now())
       returning event_id, paddle_id`,
      [hold.id, status, onlyIfExpired],
    );
    const row = rows[0];
    if (!row) return false;
    await appendEventLog(client, [
      { eventId: row.event_id, paddleId: row.paddle_id, type: "hold", payload: { holdId: hold.id, status } },
    ]);
    return true;
  });
}

async function recordFailedRelease(db: Queryable, hold: LiveAuthorization, error: unknown): Promise<void> {
  const record = error instanceof PaypalError ? error.toRecord() : { operation: "void", code: "UNKNOWN", httpStatus: null, debugId: null };
  // The failure stays on the hold, as a raise's failed void does, and in error_log past Render's 7 days.
  await db.query(
    `update holds set paypal_debug_id = $2, raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('last_error', $3::jsonb)
     where id = $1`,
    [hold.id, record.debugId, JSON.stringify(record)],
  );
  await db.query(
    `insert into error_log (source, code, message, event_id, paddle_id, paypal_debug_id, detail)
     values ('cron', $1, $2, $3, $4, $5, $6::jsonb)`,
    [record.code, `Could not void the authorization of hold ${hold.id}`, hold.eventId, hold.paddleId, record.debugId, JSON.stringify({ holdId: hold.id })],
  );
}

export type ReleaseOutcome =
  /** Nothing stays held for this hold. */
  | "released"
  /** PayPal could not void it now; the sweep tries again in 15 minutes. */
  | "failed";

/** Voids one authorization and records the answer. Never throws for a PayPal failure. */
export async function releaseAuthorization(hold: LiveAuthorization, { pool, paymentsFor }: ReleaseDependencies): Promise<ReleaseOutcome> {
  try {
    await paymentsFor(hold.kind).void({
      authorizationId: hold.originalAuthorizationId,
      idempotencyKey: paypalRequestId("void", hold.id),
    });
    await endHold(pool, hold, "voided");
    return "released";
  } catch (error) {
    if (error instanceof PaypalError) {
      if (error.is("PREVIOUSLY_VOIDED", "AUTHORIZATION_VOIDED")) {
        await endHold(pool, hold, "voided");
        return "released";
      }
      if (error.is("AUTHORIZATION_EXPIRED")) {
        await endHold(pool, hold, "expired");
        return "released";
      }
      if (error.is("PREVIOUSLY_CAPTURED", "AUTHORIZATION_ALREADY_CAPTURED")) {
        // Captured with nothing left held. The hold's record was wrong, so this one is worth keeping.
        await recordFailedRelease(pool, hold, error);
        await endHold(pool, hold, "captured");
        return "released";
      }
      if (error.is("INVALID_RESOURCE_ID", "RESOURCE_NOT_FOUND")) {
        // PayPal has no such authorization, as after a restart in keyless mode, whose simulation is
        // per process. There is nothing to void and no later answer will differ.
        await recordFailedRelease(pool, hold, error);
        await endHold(pool, hold, "voided");
        return "released";
      }
    }
    await recordFailedRelease(pool, hold, error);
    console.error(`[director] voiding the authorization of hold ${hold.id} failed:`, error);
    return "failed";
  }
}
