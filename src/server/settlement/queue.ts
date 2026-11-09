/**
 * The settlement queue. Its state is the settlement_items table, so it survives a restart: claiming
 * an item stamps a lease in next_attempt_at, and an item whose worker died comes back when the lease
 * runs out, with the same PayPal-Request-Id, so PayPal replays its answer instead of charging again.
 *
 * Claims use FOR UPDATE SKIP LOCKED, so overlapping processes during a deploy, or a route's kick
 * beside the tick, never take the same item. PayPal is called between transactions, never inside one.
 *
 * capture: the won total on the current authorization id, with final_capture and one invoice id per
 *          item; then a read-back, voiding the rest if PayPal shows PARTIALLY_CAPTURED.
 * void:    the original authorization id, for a real hold that won nothing.
 * simulate: the database only, for a simulated guest.
 */
import { paypalRequestId } from "@/server/paypal/idempotency";
import { PaypalError } from "@/server/paypal/errors";
import type { Capture, HoldKind } from "@/server/paypal/payments";
import { appendEventLog, type EventLogEntry } from "@/server/sse/notify";
import type { EventSettlementStatusPayload, SettlementFinishedPayload } from "@/server/sse/types";

import { logSettlementError, resolveDependencies, settlementTransaction, type SettlementDependencies } from "./dependencies";
import {
  attemptNumber,
  backoffSeconds,
  invoiceIdFor,
  itemRequestId,
  noteToPayerFor,
  triesAfterRetry,
  triesInAttempt,
  TRIES_PER_ATTEMPT,
} from "./plan";
import { reauthorizeHold } from "./reauthorize";
import {
  completeItem,
  itemEvent,
  publish,
  reopenSettlement,
  storeAwaitingPaypal,
  storeCaptured,
  storeFailedAttempt,
  storeReleased,
  storeRetryLater,
  storeSimulated,
  type ItemRef,
} from "./store";
import type { SettlementAction, SettlementItemStatus, SettlementStatus } from "./types";

/** Items worked on at once. Simulated ones take milliseconds; real ones wait on PayPal. */
const BATCH_SIZE = 8;
/**
 * How long a claim keeps an item. It outlasts the slowest try (reauthorize, capture and read-back at
 * the client's 30-second timeout each), so a live worker is not joined by a second one.
 */
const LEASE_SECONDS = 120;

/** On a succeeded item, what did not stop the charge but needs a look. */
export const NOTE_READBACK_FAILED = "READBACK_FAILED";
export const NOTE_REMAINDER_NOT_RELEASED = "REMAINDER_NOT_RELEASED";

export interface ClaimedItem extends ItemRef {
  amountCents: number;
  /** Tries so far, this one included. */
  tries: number;
  requestId: string | null;
  /** Set once this try knows the charge is stored: from then on only the read-back is left. */
  charged: boolean;
}

interface ClaimedRow {
  id: string;
  settlement_id: string;
  event_id: string;
  paddle_id: string;
  paddle_number: number;
  hold_id: string;
  action: SettlementAction;
  amount_cents: number;
  released_cents: number;
  status: SettlementItemStatus;
  attempts: number;
  paypal_request_id: string | null;
  paypal_capture_id: string | null;
  error_code: string | null;
}

/** The largest charges go first, so a winner's row moves before the long tail of released holds. */
async function claimDueItems(dependencies: SettlementDependencies): Promise<ClaimedItem[]> {
  const { rows } = await dependencies.pool.query<ClaimedRow>(
    `with due as (
       select i.id
       from settlement_items i
       where i.settlement_id in (select id from settlements where status = 'running')
         and i.status in ('queued', 'processing')
         and (i.next_attempt_at is null or i.next_attempt_at <= clock_timestamp())
       order by i.amount_cents desc, i.id
       limit $1
       for update skip locked
     ), claimed as (
       update settlement_items i
       set status = 'processing', attempts = i.attempts + 1,
           next_attempt_at = clock_timestamp() + make_interval(secs => $2::int)
       from due
       where i.id = due.id
       returning i.*
     )
     select c.id, c.settlement_id, s.event_id, c.paddle_id, p.number as paddle_number, c.hold_id, c.action,
       c.amount_cents, c.released_cents, c.status, c.attempts, c.paypal_request_id, c.paypal_capture_id, c.error_code
     from claimed c
     join settlements s on s.id = c.settlement_id
     join paddles p on p.id = c.paddle_id
     order by c.amount_cents desc, c.id`,
    [BATCH_SIZE, LEASE_SECONDS],
  );

  // News only, for the rows that wait on PayPal: failing to send it must not stop the charge.
  const moving = rows.filter((row) => row.action !== "simulate");
  if (moving.length > 0) {
    await publish(
      dependencies.pool,
      moving.map((row) => itemEvent(toItem(row), row)),
    ).catch((error: unknown) => console.error("[settlement] could not publish a claim:", error));
  }
  return rows.map(toItem);
}

function toItem(row: ClaimedRow): ClaimedItem {
  return {
    id: row.id,
    settlementId: row.settlement_id,
    eventId: row.event_id,
    paddleId: row.paddle_id,
    paddleNumber: row.paddle_number,
    holdId: row.hold_id,
    action: row.action,
    amountCents: row.amount_cents,
    tries: row.attempts,
    requestId: row.paypal_request_id,
    charged: false,
  };
}

export interface QueueResult {
  /** Items this call tried. */
  processed: number;
  /** Settlements this call finished. */
  finished: number;
}

/** Works through every item that is due now; one a backoff or a lease holds back waits for a later call. */
export async function processSettlementQueue(overrides: Partial<SettlementDependencies> = {}): Promise<QueueResult> {
  const dependencies = resolveDependencies(overrides);
  let processed = 0;
  let finished = await finishDueSettlements(dependencies);
  for (;;) {
    const claimed = await claimDueItems(dependencies);
    if (claimed.length === 0) break;
    await Promise.all(claimed.map((item) => processItem(item, dependencies)));
    processed += claimed.length;
    finished += await finishDueSettlements(dependencies);
  }
  return { processed, finished };
}

async function processItem(item: ClaimedItem, dependencies: SettlementDependencies): Promise<void> {
  try {
    if (item.action === "simulate") await storeSimulated(dependencies.pool, item);
    else if (item.action === "void") await settleVoid(item, dependencies);
    else await settleCapture(item, dependencies);
  } catch (error) {
    try {
      await recordFailedTry(item, error, dependencies);
    } catch (recordError) {
      // The database is out too. The lease runs out and the item comes back with its request id.
      console.error(`[settlement] item ${item.id} could not record its failure:`, recordError);
    }
  }
}

// A real hold that won nothing ----------------------------------------------------------------------

interface HoldForSettlement {
  kind: HoldKind;
  status: string;
  amount_cents: number;
  original_authorization_id: string | null;
  current_authorization_id: string | null;
  authorized_at: Date | null;
  past_honor: boolean;
  is_demo: boolean;
  soft_descriptor: string | null;
  charity_name: string;
}

async function loadHold(dependencies: SettlementDependencies, holdId: string): Promise<HoldForSettlement> {
  const { rows } = await dependencies.pool.query<HoldForSettlement>(
    `select h.kind, h.status, h.amount_cents, h.original_authorization_id, h.current_authorization_id, h.authorized_at,
       coalesce(h.honor_until <= clock_timestamp(), false) as past_honor,
       e.is_demo, e.soft_descriptor, e.charity_name
     from holds h join events e on e.id = h.event_id
     where h.id = $1`,
    [holdId],
  );
  const hold = rows[0];
  if (!hold) throw new Error(`No hold ${holdId}`);
  return hold;
}

async function settleVoid(item: ClaimedItem, dependencies: SettlementDependencies): Promise<void> {
  const hold = await loadHold(dependencies, item.holdId);
  // A webhook or the sweep got here first.
  if (hold.status === "voided" || hold.status === "expired") {
    await storeReleased(dependencies.pool, item, { holdStatus: hold.status, debugId: null });
    return;
  }
  if (!hold.original_authorization_id || !item.requestId) {
    await failAttempt(item, { code: "NO_AUTHORIZATION", debugId: null }, dependencies);
    return;
  }
  const outcome = await releaseAuthorization(
    {
      kind: hold.kind,
      authorizationId: hold.original_authorization_id,
      idempotencyKey: item.requestId,
    },
    dependencies,
  );
  await storeReleased(dependencies.pool, item, outcome);
}

/**
 * Voids on the original id (a reauthorization cannot be voided). PayPal saying it is already voided
 * means it is done, and an expired authorization holds nothing either.
 */
async function releaseAuthorization(
  request: { kind: HoldKind; authorizationId: string; idempotencyKey: string },
  dependencies: SettlementDependencies,
): Promise<{ holdStatus: "voided" | "expired"; debugId: string | null }> {
  try {
    const result = await dependencies.paymentsFor(request.kind).void({
      authorizationId: request.authorizationId,
      idempotencyKey: request.idempotencyKey,
    });
    return { holdStatus: "voided", debugId: result.debugId ?? null };
  } catch (error) {
    if (error instanceof PaypalError && error.is("PREVIOUSLY_VOIDED", "AUTHORIZATION_VOIDED")) {
      return { holdStatus: "voided", debugId: error.debugId ?? null };
    }
    if (error instanceof PaypalError && error.is("AUTHORIZATION_EXPIRED")) {
      return { holdStatus: "expired", debugId: error.debugId ?? null };
    }
    throw error;
  }
}

// A winner ------------------------------------------------------------------------------------------

async function settleCapture(item: ClaimedItem, dependencies: SettlementDependencies): Promise<void> {
  const hold = await loadHold(dependencies, item.holdId);
  // Captured and stored by an earlier try or a webhook, the read-back is all that is left.
  item.charged = hold.status === "captured" || (await chargeHold(item, hold, dependencies));
  if (item.charged) await readBack(item, hold, dependencies);
}

/** True once the charge is stored; false when this try ended the item some other way. */
async function chargeHold(
  item: ClaimedItem,
  hold: HoldForSettlement,
  dependencies: SettlementDependencies,
): Promise<boolean> {
  const refusal = captureRefusal(item, hold);
  if (refusal || !item.requestId) {
    await failAttempt(item, { code: refusal ?? "NO_REQUEST_ID", debugId: null }, dependencies);
    return false;
  }

  const authorizationId = await authorizationToCapture(item, hold, dependencies);
  let answer: Capture;
  try {
    answer = await dependencies.paymentsFor(hold.kind).capture({
      authorizationId,
      amountCents: item.amountCents,
      invoiceId: invoiceIdFor(item.eventId, item.paddleNumber),
      softDescriptor: hold.soft_descriptor ?? "FAIRHOLD",
      noteToPayer: noteToPayerFor(hold.charity_name),
      idempotencyKey: item.requestId,
    });
  } catch (error) {
    if (error instanceof PaypalError && error.is("AUTHORIZATION_ALREADY_CAPTURED", "DUPLICATE_INVOICE_ID")) {
      await settleAlreadyCaptured(item, hold, authorizationId, error, dependencies);
      return false;
    }
    throw error;
  }

  switch (answer.status) {
    case "PENDING":
      await storeAwaitingPaypal(dependencies.pool, item, {
        captureId: answer.captureId,
        debugId: answer.debugId ?? null,
        code: null,
      });
      return false;
    case "DECLINED":
    case "FAILED":
      await failAttempt(item, { code: `CAPTURE_${answer.status}`, debugId: answer.debugId ?? null }, dependencies);
      return false;
    default:
      // COMPLETED; a replay after a refund still means this charge went through.
      await storeCaptured(dependencies.pool, item, {
        captureId: answer.captureId,
        amountCents: answer.amountCents,
        debugId: answer.debugId ?? null,
        createdAt: answer.createdAt ?? null,
      });
      return true;
  }
}

/** The last word before PayPal is called: no capture may exceed the authorization it draws on. */
function captureRefusal(item: ClaimedItem, hold: HoldForSettlement): string | null {
  if (hold.status !== "authorized") return `HOLD_${hold.status.toUpperCase()}`;
  if (!hold.current_authorization_id) return "NO_AUTHORIZATION";
  if (item.amountCents > hold.amount_cents) return "OVER_AUTHORIZATION";
  return null;
}

/** A hold past its honor period is renewed first, except on a demo, whose holds never get that old. */
async function authorizationToCapture(
  item: ClaimedItem,
  hold: HoldForSettlement,
  dependencies: SettlementDependencies,
): Promise<string> {
  const current = hold.current_authorization_id;
  if (!current) throw new Error(`Hold ${item.holdId} has no authorization`);
  if (!hold.past_honor || hold.is_demo || !hold.original_authorization_id) return current;
  const outcome = await reauthorizeHold(
    {
      id: item.holdId,
      paddleId: item.paddleId,
      kind: hold.kind,
      amountCents: hold.amount_cents,
      originalAuthorizationId: hold.original_authorization_id,
      authorizedAt: hold.authorized_at,
    },
    dependencies,
  );
  return outcome.kind === "reauthorized" ? outcome.authorizationId : current;
}

/**
 * PayPal refuses this capture because of an earlier one. If the authorization really was captured,
 * the money moved and only its capture id is missing, which PAYMENT.CAPTURE.COMPLETED brings. If it
 * was not, the refusal stands as a failure.
 */
async function settleAlreadyCaptured(
  item: ClaimedItem,
  hold: HoldForSettlement,
  authorizationId: string,
  refusal: PaypalError,
  dependencies: SettlementDependencies,
): Promise<void> {
  const read = await dependencies.paymentsFor(hold.kind).getAuthorization(authorizationId);
  if (read.status === "CAPTURED" || read.status === "PARTIALLY_CAPTURED") {
    await storeAwaitingPaypal(dependencies.pool, item, {
      captureId: null,
      debugId: refusal.debugId ?? null,
      code: refusal.code,
    });
    return;
  }
  await failAttempt(item, { code: refusal.code, debugId: refusal.debugId ?? null }, dependencies);
}

/**
 * The PARTIALLY_CAPTURED guard. final_capture releases the rest of the hold, and this reads back to
 * be sure: if part of the authorization is still open, it is voided on the original id. The charge
 * stands whatever happens here, so a failure leaves a note on the item, not a failed row.
 */
async function readBack(item: ClaimedItem, hold: HoldForSettlement, dependencies: SettlementDependencies): Promise<void> {
  const fresh = await loadHold(dependencies, item.holdId);
  const authorizationId = fresh.current_authorization_id ?? hold.current_authorization_id;
  if (!authorizationId) throw new Error(`Hold ${item.holdId} was captured without an authorization`);

  const payments = dependencies.paymentsFor(hold.kind);
  const read = await payments.getAuthorization(authorizationId);
  let note: string | null = null;
  if (read.status === "PARTIALLY_CAPTURED" && fresh.original_authorization_id) {
    try {
      await releaseAuthorization(
        {
          kind: hold.kind,
          authorizationId: fresh.original_authorization_id,
          idempotencyKey: paypalRequestId("void", item.id),
        },
        dependencies,
      );
    } catch (error) {
      if (!(error instanceof PaypalError) || !isFinalAnswer(error)) throw error;
      note = NOTE_REMAINDER_NOT_RELEASED;
      await logSettlementError(dependencies.pool, {
        code: NOTE_REMAINDER_NOT_RELEASED,
        message: `Paddle ${item.paddleNumber}: PayPal refused to void the rest of a partly captured hold: ${error.code}`,
        eventId: item.eventId,
        paddleId: item.paddleId,
        debugId: error.debugId,
      });
    }
  }
  await completeItem(dependencies.pool, item, { note, debugId: read.debugId ?? null });
}

// Failures ------------------------------------------------------------------------------------------

/** PayPal's final answer for this attempt: the row shows failed, and a retry is a new request. */
async function failAttempt(
  item: ClaimedItem,
  failure: { code: string; debugId: string | null },
  dependencies: SettlementDependencies,
): Promise<void> {
  const stored = await storeFailedAttempt(
    dependencies.pool,
    item,
    {
      ...failure,
      nextRequestId: itemRequestId(item.action, item.id, attemptNumber(item.tries) + 1),
    },
    item.tries,
  );
  if (!stored) return;
  await logSettlementError(dependencies.pool, {
    code: failure.code,
    message: `Paddle ${item.paddleNumber}: ${item.action} failed: ${failure.code}`,
    eventId: item.eventId,
    paddleId: item.paddleId,
    debugId: failure.debugId,
  });
}

/**
 * Only PayPal refusing the request decides it. A timeout, a 5xx, an expired token or an answer this
 * app could not read says nothing about whether the money moved, so those keep their request id.
 */
function isFinalAnswer(error: PaypalError): boolean {
  const status = error.httpStatus;
  return !error.retryable && status !== undefined && status >= 400 && status < 500 && status !== 401;
}

async function recordFailedTry(item: ClaimedItem, error: unknown, dependencies: SettlementDependencies): Promise<void> {
  const paypal = error instanceof PaypalError ? error : null;
  const code = paypal?.code ?? "INTERNAL_ERROR";
  const debugId = paypal?.debugId ?? null;
  if (!paypal) {
    await logSettlementError(dependencies.pool, {
      code,
      message: `Paddle ${item.paddleNumber}: ${item.action}: ${error instanceof Error ? error.message : String(error)}`,
      eventId: item.eventId,
      paddleId: item.paddleId,
    });
  }

  // The charge already stands; this was the read-back. It gets the retries, and then a note.
  const decided = paypal !== null && isFinalAnswer(paypal);
  const outOfTries = triesInAttempt(item.tries) >= TRIES_PER_ATTEMPT;
  if (item.charged && (decided || outOfTries)) {
    await completeItem(dependencies.pool, item, { note: NOTE_READBACK_FAILED, debugId });
    return;
  }
  if (decided) {
    await failAttempt(item, { code, debugId }, dependencies);
    return;
  }
  if (outOfTries) {
    // The outcome stays unknown, so the request id stays too: a retry must not be a new charge.
    const stored = await storeFailedAttempt(dependencies.pool, item, { code, debugId, nextRequestId: null }, item.tries);
    if (stored) {
      await logSettlementError(dependencies.pool, {
        code,
        message: `Paddle ${item.paddleNumber}: ${item.action} ran out of tries; PayPal's answer is unknown`,
        eventId: item.eventId,
        paddleId: item.paddleId,
        debugId,
      });
    }
    return;
  }
  await storeRetryLater(
    dependencies.pool,
    item,
    { code, debugId, delaySeconds: backoffSeconds(triesInAttempt(item.tries)) },
    item.tries,
  );
}

// An organizer's retry ------------------------------------------------------------------------------

export type RetryResult =
  | { kind: "queued" }
  /**
   * Nothing to retry: it is not failed or waiting, for instance after a double click, or its event
   * has left settling, as a retired demo has. Its hold is being released, and a capture would race that.
   */
  | { kind: "not_retryable"; status: SettlementItemStatus }
  | { kind: "not_found" };

/**
 * Puts a failed or waiting row back on the queue. The stored request id is what the next call sends:
 * storeFailedAttempt already replaced it after a final answer, and it stands after an unknown one.
 */
export async function retrySettlementItem(
  eventId: string,
  itemId: string,
  overrides: Partial<SettlementDependencies> = {},
): Promise<RetryResult> {
  const { pool } = resolveDependencies(overrides);
  return settlementTransaction(pool, async (client) => {
    const { rows } = await client.query<ClaimedRow>(
      `select i.id, i.settlement_id, s.event_id, i.paddle_id, p.number as paddle_number, i.hold_id, i.action,
         i.amount_cents, i.released_cents, i.status, i.attempts, i.paypal_request_id, i.paypal_capture_id, i.error_code
       from settlement_items i
       join settlements s on s.id = i.settlement_id
       join paddles p on p.id = i.paddle_id
       where i.id = $1 and s.event_id = $2
       for update of i`,
      [itemId, eventId],
    );
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    if (row.status !== "failed" && row.status !== "pending") return { kind: "not_retryable", status: row.status };

    // In the queue's order, the item, then its settlement, then the event. FOR SHARE keeps the event
    // from being retired (fenceSettlement) until this reopened settlement is there for it to see.
    await client.query("select id from settlements where id = $1 for update", [row.settlement_id]);
    const { rows: events } = await client.query<{ status: string }>("select status from events where id = $1 for share", [eventId]);
    if (events[0]?.status !== "settling") return { kind: "not_retryable", status: row.status };

    await client.query(
      `update settlement_items set status = 'queued', attempts = $2, next_attempt_at = null, error_code = null where id = $1`,
      [itemId, triesAfterRetry(row.attempts)],
    );
    await reopenSettlement(client, row.settlement_id);
    await appendEventLog(client, [itemEvent(toItem(row), { ...row, status: "queued", error_code: null })]);
    return { kind: "queued" };
  });
}

// Finishing -----------------------------------------------------------------------------------------

/**
 * Moves every settlement whose items have all ended: done and the event settled when each one
 * succeeded; done_with_errors otherwise, with the event still settling until a retry or a webhook
 * brings the last rows through. Also the recovery path after a crash right before this step.
 */
export async function finishDueSettlements(dependencies: SettlementDependencies): Promise<number> {
  const { rows } = await dependencies.pool.query<{ id: string }>(
    `select s.id from settlements s
     where s.status = 'running'
       and not exists (
         select 1 from settlement_items i where i.settlement_id = s.id and i.status in ('queued', 'processing')
       )`,
  );
  let finished = 0;
  for (const { id } of rows) {
    const eventId = await finishSettlement(id, dependencies);
    if (!eventId) continue;
    finished += 1;
    // A raise whose void failed, or a late approval's, is still holding the guest's money.
    await voidReplacedHolds({ eventId }, dependencies).catch((error: unknown) =>
      console.error(`[settlement] voiding the replaced holds of event ${eventId} failed:`, error),
    );
  }
  return finished;
}

async function finishSettlement(settlementId: string, dependencies: SettlementDependencies): Promise<string | null> {
  return settlementTransaction(dependencies.pool, async (client) => {
    const { rows } = await client.query<{ event_id: string; status: SettlementStatus }>(
      "select event_id, status from settlements where id = $1 for update",
      [settlementId],
    );
    const settlement = rows[0];
    if (settlement?.status !== "running") return null;

    const counts = await client.query<{ active: number; unresolved: number }>(
      `select count(*) filter (where status in ('queued', 'processing'))::int as active,
         count(*) filter (where status in ('failed', 'pending'))::int as unresolved
       from settlement_items where settlement_id = $1`,
      [settlementId],
    );
    if ((counts.rows[0]?.active ?? 0) > 0) return null;

    const status = (counts.rows[0]?.unresolved ?? 0) > 0 ? "done_with_errors" : "done";
    await client.query("update settlements set status = $2, finished_at = clock_timestamp() where id = $1", [
      settlementId,
      status,
    ]);
    const finished: SettlementFinishedPayload = { kind: "settlement_finished", settlementId, status };
    const entries: EventLogEntry[] = [{ eventId: settlement.event_id, paddleId: null, type: "settlement", payload: finished }];
    if (status === "done") {
      await client.query(
        "update events set status = 'settled', settled_at = clock_timestamp() where id = $1 and status = 'settling'",
        [settlement.event_id],
      );
      const settled: EventSettlementStatusPayload = { kind: "event_settled", status: "settled" };
      entries.push({ eventId: settlement.event_id, paddleId: null, type: "event_status", payload: settled });
    }
    await appendEventLog(client, entries);
    return settlement.event_id;
  });
}

// Holds that are not the paddle's bidding power -----------------------------------------------------

export interface ReplacedVoidResult {
  voided: number;
  failed: number;
}

/**
 * Retries the void of every replaced hold that still has an authorization: a raise whose void
 * failed, or an approval refused as bidding power. These have no settlement item, because they were
 * never the hold settlement charges. The request id is the one the PayPal window's flow used, so a
 * void that did get through replays. Settlement's finish and the webhook call this for one event. The
 * sweep has its own loop over every event (director/sweep.ts, with terminal codes and a batch limit);
 * it sends the same request id, so the two can never void twice.
 */
export async function voidReplacedHolds(
  filter: { eventId?: string } = {},
  overrides: Partial<SettlementDependencies> = {},
): Promise<ReplacedVoidResult> {
  const dependencies = resolveDependencies(overrides);
  const { rows } = await dependencies.pool.query<{ id: string; kind: HoldKind; original_authorization_id: string }>(
    `select id, kind, original_authorization_id from holds
     where status = 'replaced' and original_authorization_id is not null
       and ($1::uuid is null or event_id = $1::uuid)
     order by created_at, id`,
    [filter.eventId ?? null],
  );

  const result: ReplacedVoidResult = { voided: 0, failed: 0 };
  for (const hold of rows) {
    try {
      await releaseAuthorization(
        {
          kind: hold.kind,
          authorizationId: hold.original_authorization_id,
          idempotencyKey: paypalRequestId("void", hold.id),
        },
        dependencies,
      );
      await dependencies.holdStore.markReplacedVoided(hold.id);
      result.voided += 1;
    } catch (error) {
      if (!(error instanceof PaypalError)) throw error;
      await dependencies.holdStore.recordPaypalError(hold.id, error.toRecord());
      result.failed += 1;
    }
  }
  return result;
}
