/**
 * Applies the verified events in paypal_webhook_events to holds and settlement items. API responses
 * are the source of truth; webhooks only reconcile, by a state machine that moves forward and never
 * back: a capture already recorded stays recorded whatever arrives after it, deliveries may come in
 * any order and more than once, and an event about a hold or item this app does not know is ignored.
 *
 * Applying is idempotent, so a row applied twice (a crash before processed_at, or the route and the
 * tick together) changes nothing the second time.
 */
import { z } from "zod";

import { PaypalError } from "@/server/paypal/errors";
import { createPostgresHoldStore, type HoldAuthorization, type HoldRecord, type HoldStore } from "@/server/paypal/hold-store";
import { HONOR_PERIOD_MS, completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalValueToCents } from "@/server/paypal/money";
import { getPayments } from "@/server/paypal/runtime";
import { appendEventLog } from "@/server/sse/notify";

import { logSettlementError, resolveDependencies, settlementTransaction, type SettlementDependencies } from "./dependencies";
import { attemptNumber, itemRequestId } from "./plan";
import { voidReplacedHolds } from "./queue";
import { storeAwaitingPaypal, storeCaptured, storeFailedAttempt, storeReleased, type ItemRef } from "./store";
import type { SettlementAction, SettlementItemStatus } from "./types";

export interface WebhookDependencies extends SettlementDependencies {
  holdFlow: HoldFlowDependencies;
  holds: HoldStore;
  /** After an event put an item back on the queue. */
  afterRequeue: () => void;
}

function resolveWebhookDependencies(overrides: Partial<WebhookDependencies> = {}): WebhookDependencies {
  const settlement = resolveDependencies(overrides);
  const holds = overrides.holds ?? createPostgresHoldStore();
  return {
    ...settlement,
    holds,
    holdFlow: overrides.holdFlow ?? {
      store: holds,
      paymentsFor: getPayments,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    afterRequeue: overrides.afterRequeue ?? (() => {}),
  };
}

export interface ProcessWebhooksOptions {
  /** Only this event, as the route does right after storing it. */
  paypalEventId?: string;
  /** Rows at least this old; the tick leaves fresh ones to the route that just stored them. */
  olderThanSeconds?: number;
  /** Also rows that failed before. They wait for this, so a broken one does not repeat every second. */
  retryFailed?: boolean;
  limit?: number;
}

export interface ProcessWebhooksResult {
  applied: number;
  failed: number;
}

interface WebhookRow {
  paypal_event_id: string;
  event_type: string;
  payload: { resource?: unknown };
}

export async function processWebhookEvents(
  options: ProcessWebhooksOptions = {},
  overrides: Partial<WebhookDependencies> = {},
): Promise<ProcessWebhooksResult> {
  const dependencies = resolveWebhookDependencies(overrides);
  const { rows } = await dependencies.pool.query<WebhookRow>(
    `select paypal_event_id, event_type, payload
     from paypal_webhook_events
     where processed_at is null and verified
       and ($1::text is null or paypal_event_id = $1)
       and ($2::boolean or error is null)
       and received_at <= now() - make_interval(secs => $3::int)
     order by received_at, paypal_event_id
     limit $4`,
    [options.paypalEventId ?? null, options.retryFailed ?? options.paypalEventId !== undefined, options.olderThanSeconds ?? 0, options.limit ?? 50],
  );

  const result: ProcessWebhooksResult = { applied: 0, failed: 0 };
  for (const row of rows) {
    try {
      await applyEvent(row, dependencies);
      await dependencies.pool.query(
        "update paypal_webhook_events set processed_at = clock_timestamp(), error = null where paypal_event_id = $1",
        [row.paypal_event_id],
      );
      result.applied += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      await dependencies.pool.query("update paypal_webhook_events set error = $2 where paypal_event_id = $1", [
        row.paypal_event_id,
        message.slice(0, 500),
      ]);
      await logSettlementError(dependencies.pool, {
        source: "webhook",
        code: row.event_type,
        message: `Applying ${row.paypal_event_id} failed: ${message}`,
      });
    }
  }
  return result;
}

async function applyEvent(row: WebhookRow, dependencies: WebhookDependencies): Promise<void> {
  const { resource } = row.payload;
  switch (row.event_type) {
    case "CHECKOUT.ORDER.APPROVED":
      return applyOrderApproved(resource, dependencies);
    case "CHECKOUT.PAYMENT-APPROVAL.REVERSED":
      return applyApprovalReversed(resource, dependencies);
    case "PAYMENT.AUTHORIZATION.CREATED":
      return applyAuthorizationCreated(resource, dependencies);
    case "PAYMENT.AUTHORIZATION.VOIDED":
      return applyAuthorizationVoided(resource, dependencies);
    case "PAYMENT.CAPTURE.COMPLETED":
      return applyCaptureCompleted(resource, dependencies);
    case "PAYMENT.CAPTURE.PENDING":
      return applyCapturePending(resource, dependencies);
    case "PAYMENT.CAPTURE.DECLINED":
      return applyCaptureDeclined(resource, dependencies);
    case "PAYMENT.CAPTURE.REFUNDED":
    case "PAYMENT.CAPTURE.REVERSED":
      // Refunds and disputes are out of scope: someone did this in PayPal's own tools.
      await logSettlementError(dependencies.pool, {
        source: "webhook",
        code: row.event_type,
        message: `${row.event_type} for ${readResourceId(resource) ?? "an unknown resource"}: logged, nothing changes`,
      });
      return;
    default:
      return;
  }
}

function readResourceId(resource: unknown): string | null {
  const id = (resource as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : null;
}

// Holds: the backstop for a PayPal window whose return page never ran --------------------------------

const orderResource = z.object({
  id: z.string().optional(),
  order_id: z.string().optional(),
  purchase_units: z.array(z.object({ custom_id: z.string().optional() })).optional(),
});

async function pendingHoldOfOrder(resource: unknown, dependencies: WebhookDependencies): Promise<{ hold: HoldRecord; orderId: string | null } | null> {
  const parsed = orderResource.safeParse(resource);
  if (!parsed.success) return null;
  const orderId = parsed.data.order_id ?? parsed.data.id ?? null;
  const customId = parsed.data.purchase_units?.[0]?.custom_id ?? null;
  let holdId = customId;
  if (!holdId && orderId) {
    const { rows } = await dependencies.pool.query<{ id: string }>("select id from holds where paypal_order_id = $1", [orderId]);
    holdId = rows[0]?.id ?? null;
  }
  const hold = holdId ? await dependencies.holds.findHold(holdId) : null;
  return hold && hold.status === "pending_approval" ? { hold, orderId } : null;
}

async function applyOrderApproved(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const found = await pendingHoldOfOrder(resource, dependencies);
  if (!found) return;
  const outcome = await completeHoldApproval({ holdId: found.hold.id, orderId: found.orderId }, dependencies.holdFlow);
  // PayPal or the network hiccupped: stay unprocessed, and the retry pass tries again.
  if (outcome.kind === "pending" && outcome.error?.retryable) throw outcome.error;
}

async function applyApprovalReversed(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const found = await pendingHoldOfOrder(resource, dependencies);
  if (found) await dependencies.holds.markCanceled(found.hold.id);
}

const authorizationResource = z.object({
  id: z.string(),
  status: z.string().optional(),
  custom_id: z.string().optional(),
  amount: z.object({ value: z.string() }).optional(),
  create_time: z.string().optional(),
  expiration_time: z.string().optional(),
});

/** The authorization an event carries, as markAuthorized stores it. */
function authorizationOf(
  data: z.output<typeof authorizationResource>,
  resource: unknown,
  amountCents: number,
  dependencies: WebhookDependencies,
): HoldAuthorization {
  const authorizedAt = data.create_time ? new Date(data.create_time) : dependencies.now();
  return {
    authorizationId: data.id,
    amountCents,
    authorizedAt,
    honorUntil: new Date(authorizedAt.getTime() + HONOR_PERIOD_MS),
    expiresAt: data.expiration_time ? new Date(data.expiration_time) : null,
    payer: { payerId: undefined, email: undefined, givenName: undefined, surname: undefined },
    raw: resource,
  };
}

/**
 * Settles what the return page cannot. Authorizing again comes first, because its answer also brings
 * the payer, and it completes an approval whose return page never ran. When it does not:
 *
 * - PayPal did authorize but the answer was lost and it stopped replaying it, so authorizing again
 *   says ORDER_ALREADY_AUTHORIZED; or PayPal held the authorization for review, and the same request
 *   id keeps replaying PENDING. Either way this event, whose custom_id is the hold id, carries the
 *   authorization itself, which counts once it says CREATED.
 * - The hold was canceled or failed here, and this is the first anyone hears of the authorization. It
 *   has no other way to be released, so it is stored for the void, and the sweep retries a failed one.
 *
 * A reauthorization also fires this event; its hold is authorized, so it is ignored here.
 */
async function applyAuthorizationCreated(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const parsed = authorizationResource.safeParse(resource);
  if (!parsed.success || !parsed.data.custom_id) return;
  const { data } = parsed;
  const hold = await dependencies.holds.findHold(parsed.data.custom_id);
  if (!hold) return;

  let authorization: HoldAuthorization;
  if (hold.status === "pending_approval") {
    if (!data.amount) return;
    const outcome = await completeHoldApproval({ holdId: hold.id, orderId: null }, dependencies.holdFlow);
    if (outcome.kind !== "pending") return;
    const inReview = outcome.error === null;
    const lostAnswer = outcome.error instanceof PaypalError && outcome.error.is("ORDER_ALREADY_AUTHORIZED");
    if (!inReview && !lostAnswer) {
      if (outcome.error?.retryable) throw outcome.error;
      return;
    }
    if (data.status !== "CREATED") return;
    authorization = authorizationOf(data, resource, paypalValueToCents(data.amount.value), dependencies);
  } else if (hold.status === "canceled" || hold.status === "denied" || hold.status === "failed") {
    if (data.status !== "CREATED" && data.status !== "PENDING") return;
    const amountCents = data.amount ? paypalValueToCents(data.amount.value) : hold.amountCents;
    authorization = authorizationOf(data, resource, amountCents, dependencies);
  } else {
    return;
  }

  const stored = await dependencies.holds.markAuthorized(hold.id, authorization);
  // A refused approval, the hold a raise displaced, or a hold that had ended: an authorization is owed its void.
  if (stored.kind !== "not_pending" || stored.status !== "authorized") await voidReplacedHolds({ eventId: hold.eventId }, dependencies);
}

/** PayPal says an authorization is gone. A captured hold stays captured. */
async function applyAuthorizationVoided(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const parsed = authorizationResource.safeParse(resource);
  if (!parsed.success) return;
  const { rows } = await dependencies.pool.query<{ id: string; status: string; event_id: string; paddle_id: string }>(
    `select id, status, event_id, paddle_id from holds
     where original_authorization_id = $1 or current_authorization_id = $1
     limit 1`,
    [parsed.data.id],
  );
  const hold = rows[0];
  if (!hold) return;

  if (hold.status === "replaced") {
    await dependencies.holds.markReplacedVoided(hold.id);
    return;
  }
  if (hold.status !== "authorized") return;

  const item = await itemOfHold(hold.id, dependencies);
  if (item?.ref.action === "void") {
    await storeReleased(dependencies.pool, item.ref, { holdStatus: "voided", debugId: null });
    return;
  }
  // The hold is gone under a live paddle or a queued charge: the engine stops counting it as bidding
  // power, and the charge, if there is one, fails with the reason when it runs.
  await settlementTransaction(dependencies.pool, async (client) => {
    await client.query("select id from paddles where id = $1 for no key update", [hold.paddle_id]);
    const { rowCount } = await client.query(
      "update holds set status = 'voided', last_synced_at = clock_timestamp() where id = $1 and status = 'authorized'",
      [hold.id],
    );
    if (rowCount !== 1) return;
    await appendEventLog(client, [
      { eventId: hold.event_id, paddleId: hold.paddle_id, type: "hold", payload: { holdId: hold.id, status: "voided" } },
    ]);
  });
}

// Captures -----------------------------------------------------------------------------------------

const captureResource = z.object({
  id: z.string(),
  status: z.string().optional(),
  amount: z.object({ value: z.string() }).optional(),
  invoice_id: z.string().optional(),
  custom_id: z.string().optional(),
  create_time: z.string().optional(),
  links: z.array(z.object({ rel: z.string().optional(), href: z.string().optional() })).optional(),
});

interface FoundItem {
  ref: ItemRef;
  status: SettlementItemStatus;
  attempts: number;
  amountCents: number;
  holdStatus: string;
  captureId: string | null;
}

const ITEM_SELECT = `
  select i.id, i.settlement_id, s.event_id, i.paddle_id, p.number as paddle_number, i.hold_id, i.action, i.status,
    i.attempts, i.amount_cents, i.paypal_capture_id, h.status as hold_status
  from settlement_items i
  join settlements s on s.id = i.settlement_id
  join paddles p on p.id = i.paddle_id
  join holds h on h.id = i.hold_id`;

interface FoundItemRow {
  id: string;
  settlement_id: string;
  event_id: string;
  paddle_id: string;
  paddle_number: number;
  hold_id: string;
  action: SettlementAction;
  status: SettlementItemStatus;
  attempts: number;
  amount_cents: number;
  paypal_capture_id: string | null;
  hold_status: string;
}

function toFound(row: FoundItemRow): FoundItem {
  return {
    ref: {
      id: row.id,
      settlementId: row.settlement_id,
      eventId: row.event_id,
      paddleId: row.paddle_id,
      paddleNumber: row.paddle_number,
      holdId: row.hold_id,
      action: row.action,
    },
    status: row.status,
    attempts: row.attempts,
    amountCents: row.amount_cents,
    holdStatus: row.hold_status,
    captureId: row.paypal_capture_id,
  };
}

async function itemOfHold(holdId: string, dependencies: SettlementDependencies): Promise<FoundItem | null> {
  const { rows } = await dependencies.pool.query<FoundItemRow>(`${ITEM_SELECT} where i.hold_id = $1`, [holdId]);
  return rows[0] ? toFound(rows[0]) : null;
}

/** The authorization a capture drew on, from its "up" link: /v2/payments/authorizations/{id}. */
function authorizationOfCapture(links: readonly { rel?: string; href?: string }[] | undefined): string | null {
  const up = links?.find((link) => link.rel === "up")?.href;
  return up ? (/\/authorizations\/([A-Za-z0-9-]+)/.exec(up)?.[1] ?? null) : null;
}

/**
 * The capture item this resource belongs to, by its capture id, the authorization it drew on, the
 * hold id it carries as custom_id, or its invoice id. A capture this app did not ask for matches none.
 */
async function itemOfCapture(
  capture: z.output<typeof captureResource>,
  dependencies: SettlementDependencies,
): Promise<FoundItem | null> {
  const { rows } = await dependencies.pool.query<FoundItemRow>(
    `${ITEM_SELECT}
     where i.action = 'capture' and (
       i.paypal_capture_id = $1
       or h.current_authorization_id = $2 or h.original_authorization_id = $2
       or h.id::text = $3
       or 'FH-' || s.event_id::text || '-' || p.number::text = $4
     )
     limit 1`,
    [capture.id, authorizationOfCapture(capture.links), capture.custom_id ?? null, capture.invoice_id ?? null],
  );
  return rows[0] ? toFound(rows[0]) : null;
}

async function applyCaptureCompleted(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const capture = captureResource.safeParse(resource);
  if (!capture.success) return;
  const item = await itemOfCapture(capture.data, dependencies);
  if (!item || item.status === "succeeded") return;
  if (item.holdStatus === "captured" && item.captureId === capture.data.id) return;

  const amountCents = capture.data.amount ? paypalValueToCents(capture.data.amount.value) : item.amountCents;
  await storeCaptured(dependencies.pool, item.ref, {
    captureId: capture.data.id,
    amountCents,
    debugId: null,
    createdAt: capture.data.create_time ? new Date(capture.data.create_time) : null,
  });
  // It may have been failed or waiting: the queue runs its read-back and finishes it.
  dependencies.afterRequeue();
}

/**
 * Only tells a row which capture it is waiting on, when it does not know yet. A row that knows one
 * has its answer from the API, and a failed row has PayPal's verdict; delivery order is not promised,
 * so this may be old news about either. Passing it up costs nothing: a row back on the queue sends
 * its request again, and PayPal answers with where that capture stands now.
 */
async function applyCapturePending(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const capture = captureResource.safeParse(resource);
  if (!capture.success) return;
  const item = await itemOfCapture(capture.data, dependencies);
  if (!item || item.status === "succeeded" || item.holdStatus === "captured") return;
  if (item.status === "failed" || item.captureId !== null) return;
  await storeAwaitingPaypal(dependencies.pool, item.ref, { captureId: capture.data.id, debugId: null, code: null });
}

/**
 * A capture that was waiting did not go through: no money moved, and a retry is a new request. Only
 * the capture the row is waiting on can fail it, since a retry may have started another. An item a
 * worker holds is left to the answer that worker gets, and a charge already recorded stands.
 */
async function applyCaptureDeclined(resource: unknown, dependencies: WebhookDependencies): Promise<void> {
  const capture = captureResource.safeParse(resource);
  if (!capture.success) return;
  const item = await itemOfCapture(capture.data, dependencies);
  if (!item) return;
  if (item.status === "succeeded" || item.holdStatus === "captured") {
    await logSettlementError(dependencies.pool, {
      source: "webhook",
      code: "CAPTURE_DECLINED_AFTER_COMPLETED",
      message: `Paddle ${item.ref.paddleNumber}: PayPal declined capture ${capture.data.id} of a charge already recorded`,
      eventId: item.ref.eventId,
      paddleId: item.ref.paddleId,
    });
    return;
  }
  if (item.captureId !== capture.data.id) return;
  await storeFailedAttempt(
    dependencies.pool,
    item.ref,
    {
      code: "CAPTURE_DECLINED",
      debugId: null,
      nextRequestId: itemRequestId(item.ref.action, item.ref.id, attemptNumber(item.attempts) + 1),
    },
    null,
  );
}
