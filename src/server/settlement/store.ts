/**
 * Every write settlement makes to a hold or a settlement item, each one transaction under the
 * paddle row lock the engine takes before it reads a hold (src/server/engine/store.ts). PayPal is
 * never called in here: a transaction never waits on the network.
 *
 * Writes only move forward. A worker that lost its lease, a replayed answer and a webhook racing
 * the API response all land on the same guards, so whichever comes second changes nothing.
 */
import type pg from "pg";

import type { HoldStatus } from "@/server/paypal/hold-store";
import { appendEventLog, type EventLogEntry } from "@/server/sse/notify";
import type { HoldStreamPayload, SettlementItemPayload } from "@/server/sse/types";

import { settlementTransaction } from "./dependencies";
import { writeReceipt } from "./receipt";
import type { SettlementAction, SettlementItemStatus } from "./types";

/** An item and what never changes about it. */
export interface ItemRef {
  id: string;
  settlementId: string;
  eventId: string;
  paddleId: string;
  paddleNumber: number;
  holdId: string;
  action: SettlementAction;
}

interface ItemRow {
  status: SettlementItemStatus;
  attempts: number;
  amount_cents: number;
  released_cents: number;
  paypal_capture_id: string | null;
  error_code: string | null;
}

interface LockedHold {
  status: HoldStatus;
  amount_cents: number;
  authorized_at: Date | null;
}

const ITEM_COLUMNS = "status, attempts, amount_cents, released_cents, paypal_capture_id, error_code";

/** The engine's order: the paddle row, then the hold, so no bid decides against a hold changing here. */
async function lockHold(client: pg.ClientBase, item: ItemRef): Promise<LockedHold> {
  await client.query("select id from paddles where id = $1 for no key update", [item.paddleId]);
  const { rows } = await client.query<LockedHold>(
    "select status, amount_cents, authorized_at from holds where id = $1 for update",
    [item.holdId],
  );
  const hold = rows[0];
  if (!hold) throw new Error(`Settlement item ${item.id} has no hold ${item.holdId}`);
  return hold;
}

async function lockItem(client: pg.ClientBase, itemId: string): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(`select ${ITEM_COLUMNS} from settlement_items where id = $1 for update`, [itemId]);
  const row = rows[0];
  if (!row) throw new Error(`No settlement item ${itemId}`);
  return row;
}

export function itemEvent(item: ItemRef, row: Omit<ItemRow, "attempts">): EventLogEntry {
  const payload: SettlementItemPayload = {
    kind: "settlement_item",
    settlementId: item.settlementId,
    itemId: item.id,
    paddleNumber: item.paddleNumber,
    action: item.action,
    status: row.status,
    amountCents: row.amount_cents,
    releasedCents: row.released_cents,
    paypalCaptureId: row.paypal_capture_id,
    errorCode: row.error_code,
  };
  return { eventId: item.eventId, paddleId: item.paddleId, type: "settlement", payload };
}

function holdEvent(item: ItemRef, payload: HoldStreamPayload): EventLogEntry {
  return { eventId: item.eventId, paddleId: item.paddleId, type: "hold", payload };
}

async function updateItem(
  client: pg.ClientBase,
  itemId: string,
  assignments: string,
  values: readonly unknown[] = [],
): Promise<ItemRow> {
  const { rows } = await client.query<ItemRow>(
    `update settlement_items set ${assignments} where id = $1 returning ${ITEM_COLUMNS}`,
    [itemId, ...values],
  );
  const row = rows[0];
  if (!row) throw new Error(`No settlement item ${itemId}`);
  return row;
}

/** A simulated guest: the database is the whole settlement, and no PayPal call is ever made. */
export async function storeSimulated(pool: pg.Pool, item: ItemRef): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    const hold = await lockHold(client, item);
    const current = await lockItem(client, item.id);
    if (current.status === "succeeded") return;

    const events: EventLogEntry[] = [];
    if (hold.status === "authorized") {
      const status: HoldStatus = current.amount_cents > 0 ? "captured" : "voided";
      await client.query(
        `update holds set status = $2, captured_cents = $3, last_synced_at = clock_timestamp() where id = $1`,
        [item.holdId, status, current.amount_cents > 0 ? current.amount_cents : null],
      );
      events.push(
        holdEvent(item, {
          holdId: item.holdId,
          status,
          ...(current.amount_cents > 0 ? { amountCents: current.amount_cents } : {}),
        }),
      );
    }
    if (current.amount_cents > 0) {
      await writeReceipt(client, {
        eventId: item.eventId,
        paddleId: item.paddleId,
        paddleNumber: item.paddleNumber,
        holdCents: hold.amount_cents,
        holdAuthorizedAt: hold.authorized_at,
        paidCents: current.amount_cents,
        captureId: null,
        issuedAt: null,
      });
    }
    const row = await updateItem(
      client,
      item.id,
      "status = 'succeeded', completed_at = clock_timestamp(), next_attempt_at = null, error_code = null",
    );
    await appendEventLog(client, [...events, itemEvent(item, row)]);
  });
}

/** PayPal released the hold (or it had expired on its own): nothing more is held for this paddle. */
export async function storeReleased(
  pool: pg.Pool,
  item: ItemRef,
  outcome: { holdStatus: "voided" | "expired"; debugId: string | null },
): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    const hold = await lockHold(client, item);
    const current = await lockItem(client, item.id);
    if (current.status === "succeeded") return;

    const events: EventLogEntry[] = [];
    if (hold.status === "authorized") {
      await client.query(
        `update holds set status = $2, paypal_debug_id = coalesce($3, paypal_debug_id), last_synced_at = clock_timestamp()
         where id = $1`,
        [item.holdId, outcome.holdStatus, outcome.debugId],
      );
      events.push(holdEvent(item, { holdId: item.holdId, status: outcome.holdStatus }));
    }
    const row = await updateItem(
      client,
      item.id,
      `status = 'succeeded', completed_at = clock_timestamp(), next_attempt_at = null, error_code = null,
       paypal_debug_id = coalesce($2, paypal_debug_id)`,
      [outcome.debugId],
    );
    await appendEventLog(client, [...events, itemEvent(item, row)]);
  });
}

export interface CapturedPayment {
  captureId: string;
  amountCents: number;
  debugId: string | null;
  createdAt: Date | null;
}

/**
 * PayPal took the money: the hold is captured, the item carries the capture id, and the receipt
 * snapshot is written, all or nothing. The item stays open until the read-back guard has run
 * (queue.ts), so a crash right after this commit still gets the guard. An item that had failed or
 * was waiting (a webhook got here first) goes back on the queue for the same reason.
 */
export async function storeCaptured(pool: pg.Pool, item: ItemRef, capture: CapturedPayment): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    const hold = await lockHold(client, item);
    const current = await lockItem(client, item.id);
    if (hold.status === "captured" && current.paypal_capture_id === capture.captureId) return;

    await client.query(
      `update holds set status = 'captured', captured_cents = $2, paypal_debug_id = coalesce($3, paypal_debug_id),
         last_synced_at = clock_timestamp()
       where id = $1`,
      [item.holdId, capture.amountCents, capture.debugId],
    );
    await writeReceipt(client, {
      eventId: item.eventId,
      paddleId: item.paddleId,
      paddleNumber: item.paddleNumber,
      holdCents: hold.amount_cents,
      holdAuthorizedAt: hold.authorized_at,
      paidCents: capture.amountCents,
      captureId: capture.captureId,
      issuedAt: capture.createdAt,
    });
    const reopened = current.status === "failed" || current.status === "pending";
    const row = await updateItem(
      client,
      item.id,
      `paypal_capture_id = $2, paypal_debug_id = coalesce($3, paypal_debug_id), amount_cents = $4, released_cents = $5,
       error_code = null,
       status = case when status in ('failed', 'pending') then 'queued'::settlement_item_status else status end,
       next_attempt_at = case when status in ('failed', 'pending') then null else next_attempt_at end`,
      [capture.captureId, capture.debugId, capture.amountCents, Math.max(0, hold.amount_cents - capture.amountCents)],
    );
    if (reopened) await reopenSettlement(client, item.settlementId);
    await appendEventLog(client, [
      holdEvent(item, { holdId: item.holdId, status: "captured", amountCents: capture.amountCents }),
      itemEvent(item, row),
    ]);
  });
}

/**
 * PayPal has the charge but has not finished it, or says the hold was captured without saying by
 * which capture. Either way a webhook settles it: the hold stays authorized and no receipt exists
 * until the money has moved.
 */
export async function storeAwaitingPaypal(
  pool: pg.Pool,
  item: ItemRef,
  outcome: { captureId: string | null; debugId: string | null; code: string | null },
): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    await lockHold(client, item);
    const current = await lockItem(client, item.id);
    if (current.status === "succeeded") return;
    const row = await updateItem(
      client,
      item.id,
      `status = 'pending', next_attempt_at = null, paypal_capture_id = coalesce($2, paypal_capture_id),
       paypal_debug_id = coalesce($3, paypal_debug_id), error_code = $4`,
      [outcome.captureId, outcome.debugId, outcome.code],
    );
    await appendEventLog(client, [itemEvent(item, row)]);
  });
}

/** The item is finished. `note` keeps a problem that did not stop it, such as a failed read-back. */
export async function completeItem(
  pool: pg.Pool,
  item: ItemRef,
  outcome: { note: string | null; debugId: string | null },
): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    const current = await lockItem(client, item.id);
    if (current.status === "succeeded") return;
    const row = await updateItem(
      client,
      item.id,
      `status = 'succeeded', completed_at = clock_timestamp(), next_attempt_at = null, error_code = $2,
       paypal_debug_id = coalesce($3, paypal_debug_id)`,
      [outcome.note, outcome.debugId],
    );
    await appendEventLog(client, [itemEvent(item, row)]);
  });
}

/**
 * PayPal gave a final answer to this attempt. The item shows as failed, and the next attempt gets a
 * new request id: reusing this one would only replay the same refusal.
 */
export async function storeFailedAttempt(
  pool: pg.Pool,
  item: ItemRef,
  failure: { code: string; debugId: string | null; nextRequestId: string | null },
  /** The claim's try count: a worker whose lease ran out has lost the item. Null for a webhook's verdict. */
  claimedTries: number | null,
): Promise<boolean> {
  return settlementTransaction(pool, async (client) => {
    const current = await lockItem(client, item.id);
    const open = claimedTries === null ? current.status === "pending" : current.status === "processing" && current.attempts === claimedTries;
    if (!open) return false;
    const row = await updateItem(
      client,
      item.id,
      `status = 'failed', next_attempt_at = null, error_code = $2, paypal_debug_id = coalesce($3, paypal_debug_id),
       paypal_request_id = coalesce($4, paypal_request_id)`,
      [failure.code, failure.debugId, failure.nextRequestId],
    );
    await appendEventLog(client, [itemEvent(item, row)]);
    return true;
  });
}

/**
 * No decided outcome: back on the queue after a delay with the same request id, so if the first try
 * did reach PayPal the next one is answered from PayPal's stored result, not charged again.
 */
export async function storeRetryLater(
  pool: pg.Pool,
  item: ItemRef,
  failure: { code: string; debugId: string | null; delaySeconds: number },
  claimedTries: number,
): Promise<void> {
  await settlementTransaction(pool, async (client) => {
    const current = await lockItem(client, item.id);
    if (current.status !== "processing" || current.attempts !== claimedTries) return;
    const row = await updateItem(
      client,
      item.id,
      `status = 'queued', next_attempt_at = clock_timestamp() + make_interval(secs => $4::int), error_code = $2,
       paypal_debug_id = coalesce($3, paypal_debug_id)`,
      [failure.code, failure.debugId, failure.delaySeconds],
    );
    await appendEventLog(client, [itemEvent(item, row)]);
  });
}

/** A finished settlement with a row back on the queue is running again; its event stayed settling. */
export async function reopenSettlement(client: pg.ClientBase, settlementId: string): Promise<void> {
  await client.query(
    "update settlements set status = 'running', finished_at = null where id = $1 and status = 'done_with_errors'",
    [settlementId],
  );
}

/** Writes rows on their own, for news that changes no other table. */
export async function publish(pool: pg.Pool, entries: readonly EventLogEntry[]): Promise<void> {
  await settlementTransaction(pool, (client) => appendEventLog(client, entries));
}
