/**
 * Opening a PayPal window: a pending hold and its AUTHORIZE order (build plan, section 2). Only the
 * guest's own request gets here, and the amount stays a request until the guest approves it at
 * PayPal; src/server/paypal/holds.ts takes it from there when the return page runs.
 *
 * The checks here are for the guest's sake: a window that would be released the moment it was
 * approved is never opened. The rule that counts is the swap's, under its locks, at approval
 * (holdSwapRefusal), because anything can change while PayPal's page is open.
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { getPool } from "@/server/db/client";
import { withTransaction } from "@/server/db/transaction";
import { eventHasEnded, getBiddingPower, type EventStatus } from "@/server/engine";
import { PaypalError } from "@/server/paypal/errors";
import { createPostgresHoldStore, holdSwapRefusal, type HoldRefusal, type HoldStore } from "@/server/paypal/hold-store";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { CreatedOrder, HoldKind, Payments } from "@/server/paypal/payments";
import { getPayments } from "@/server/paypal/runtime";
import { backHrefFor } from "@/server/paypal/window-page";
import { seededEventRefusal, takesGuests } from "@/server/sessions/join";
import { appendEventLog } from "@/server/sse/notify";

import { holdAmountMessage, holdRangeIssue, resolveHoldLimits, type HoldAmountIssue } from "./rules";

/** A guest retrying a window now and then never comes close; a looping client would, and each one calls PayPal. */
const WINDOWS_PER_PADDLE = { limit: 20, windowSeconds: 600 };

const ORDER_ATTEMPTS = 3;
const ORDER_BACKOFF_MS = 300;
/** PayPal shows the description to the buyer and would cut it here anyway. */
const MAX_DESCRIPTION_LENGTH = 127;
const SOFT_DESCRIPTOR = /^[A-Za-z0-9 .*-]{1,22}$/;

export interface CreateHoldInput {
  /** From the session (requirePaddle): the event comes with it. */
  paddleId: string;
  amountCents: number;
  /** The site's origin for PayPal's return and cancel URLs: publicOrigin(request). */
  origin: string;
  /** Where the guest goes after approving. Anything but a page of this event means the event's page. */
  next?: string | null;
}

export interface CreatedHold {
  holdId: string;
  amountCents: number;
  /** PayPal's payer-action link; in simulated mode, the return page itself. */
  approvalUrl: string;
}

export interface CreateHoldDependencies {
  pool: pg.Pool;
  paymentsFor: (kind: HoldKind) => Payments;
  store: Pick<HoldStore, "markApprovalFailed">;
  sleep: (ms: number) => Promise<void>;
}

interface PaddleEventRow {
  is_simulated: boolean;
  event_id: string;
  slug: string;
  name: string;
  status: EventStatus;
  is_demo: boolean;
  past_close: boolean;
  soft_descriptor: string | null;
  hold_presets_cents: number[] | null;
  hold_min_cents: number | null;
  hold_max_cents: number | null;
}

interface OpenedHold {
  id: string;
  kind: HoldKind;
  slug: string;
  name: string;
  softDescriptor: string | null;
}

/**
 * Inserts the pending hold and creates its order, or throws an ApiError: 400 for an amount outside
 * the event's rules, 403 event_view_only on a seeded event in production, 409 not_a_raise, below_commitments or bidding_ended, 429 past the window limit
 * and 502 paypal_unavailable. PayPal is called outside the transaction, so nothing stays locked
 * while it answers.
 */
export async function createHold(input: CreateHoldInput, dependencies: Partial<CreateHoldDependencies> = {}): Promise<CreatedHold> {
  const pool = dependencies.pool ?? getPool();
  const paymentsFor = dependencies.paymentsFor ?? getPayments;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const hold = await withTransaction(pool, (client) => openPendingHold(client, input));

  const next = backHrefFor(input.next ?? null, hold.slug);
  const query = new URLSearchParams({ hold: hold.id, next }).toString();
  let order: CreatedOrder;
  try {
    order = await createOrderWithRetries(
      () =>
        paymentsFor(hold.kind).createAuthorizeOrder({
          holdId: hold.id,
          amountCents: input.amountCents,
          description: `Bidding power hold for ${hold.name}`.slice(0, MAX_DESCRIPTION_LENGTH),
          softDescriptor: softDescriptorFor(hold),
          returnUrl: `${input.origin}/paypal/return?${query}`,
          cancelUrl: `${input.origin}/paypal/cancel?${query}`,
          idempotencyKey: paypalRequestId("create-order", hold.id),
        }),
      sleep,
    );
  } catch (error) {
    const store = dependencies.store ?? createPostgresHoldStore();
    const record =
      error instanceof PaypalError
        ? error.toRecord()
        : { operation: "createAuthorizeOrder" as const, code: "UNKNOWN", httpStatus: null, debugId: null };
    await store.markApprovalFailed(hold.id, "failed", record);
    if (!(error instanceof PaypalError)) throw error;
    console.error(`[holds] creating the order of hold ${hold.id} failed: ${error.message}`);
    throw new ApiError(502, "paypal_unavailable", "PayPal could not start this hold. Nothing was held. Please try again.");
  }

  await pool.query(
    "update holds set paypal_order_id = $2, paypal_debug_id = $3, last_synced_at = now() where id = $1",
    [hold.id, order.orderId, order.debugId ?? null],
  );
  return { holdId: hold.id, amountCents: input.amountCents, approvalUrl: order.payerActionUrl };
}

/**
 * One transaction under the paddle row lock the engine and the swap take first, so the figures it
 * reads belong together. Refused requests roll back, which also gives their count back.
 */
async function openPendingHold(client: pg.PoolClient, input: CreateHoldInput): Promise<OpenedHold> {
  const { paddleId, amountCents } = input;
  await client.query("set local lock_timeout = '5s'");
  const { rows } = await client.query<PaddleEventRow>(
    `select p.is_simulated, e.id as event_id, e.slug, e.name, e.status, e.is_demo,
       clock_timestamp() >= e.closes_at as past_close, e.soft_descriptor,
       e.hold_presets_cents, e.hold_min_cents, e.hold_max_cents
     from paddles p
     join events e on e.id = p.event_id
     where p.id = $1
     for no key update of p`,
    [paddleId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "paddle_not_found", "We could not find your paddle.");
  if (!takesGuests({ isDemo: row.is_demo })) throw seededEventRefusal();

  if (row.past_close || eventHasEnded(row.status)) throw refused({ reason: "bidding_ended" });

  const limits = resolveHoldLimits({
    presetsCents: row.hold_presets_cents,
    minCents: row.hold_min_cents,
    maxCents: row.hold_max_cents,
  });
  const range = holdRangeIssue(amountCents, limits);
  if (range) throw refused(range);

  const power = (await getBiddingPower([paddleId], client)).get(paddleId);
  const currentHoldCents = power?.holdId ? power.holdCents : null;
  // The same rule the approval will face, so the guest never approves a hold that is released at once.
  const refusal = holdSwapRefusal({
    eventStatus: row.status,
    amountCents,
    currentHoldCents,
    committedCents: power?.committedCents ?? 0,
  });
  if (refusal) throw refused(refusal);

  await enforceRateLimit(`hold:${paddleId}`, WINDOWS_PER_PADDLE, client, "Too many PayPal windows. Please try again in a few minutes.");

  const kind: HoldKind = row.is_simulated ? "simulated" : "paypal";
  const inserted = await client.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, $3, $4) returning id::text as id",
    [row.event_id, paddleId, kind, amountCents],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("insert into holds returned no id");
  await appendEventLog(client, [
    { eventId: row.event_id, paddleId, type: "hold", payload: { holdId: id, status: "pending_approval" } },
  ]);
  return { id, kind, slug: row.slug, name: row.name, softDescriptor: row.soft_descriptor };
}

function refused(issue: HoldAmountIssue | HoldRefusal): ApiError {
  switch (issue.reason) {
    case "bidding_ended":
      return new ApiError(409, "bidding_ended", "Bidding has closed for this event.");
    case "not_a_raise":
      return new ApiError(409, "not_a_raise", holdAmountMessage(issue), { currentHoldCents: issue.currentHoldCents });
    case "below_commitments":
      return new ApiError(409, "below_commitments", holdAmountMessage(issue), { committedCents: issue.committedCents });
    case "not_whole_dollars":
      return new ApiError(400, "amount_not_whole_dollars", holdAmountMessage(issue));
    case "below_minimum":
      return new ApiError(400, "amount_below_minimum", holdAmountMessage(issue), { minCents: issue.minCents });
    case "above_maximum":
      return new ApiError(400, "amount_above_maximum", holdAmountMessage(issue), { maxCents: issue.maxCents });
  }
}

/** Retries reuse the same PayPal-Request-Id, so they can never create a second order. */
async function createOrderWithRetries(create: () => Promise<CreatedOrder>, sleep: (ms: number) => Promise<void>): Promise<CreatedOrder> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await create();
    } catch (error) {
      // A timeout has already kept the guest waiting long enough.
      const retry = error instanceof PaypalError && error.retryable && error.code !== "TIMEOUT";
      if (!retry || attempt >= ORDER_ATTEMPTS) throw error;
      await sleep(ORDER_BACKOFF_MS * attempt);
    }
  }
}

/** The event's own statement text, or one PayPal accepts made from its name. */
function softDescriptorFor(hold: Pick<OpenedHold, "softDescriptor" | "name">): string {
  if (hold.softDescriptor && SOFT_DESCRIPTOR.test(hold.softDescriptor)) return hold.softDescriptor;
  return hold.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 22) || "FAIRHOLD";
}
