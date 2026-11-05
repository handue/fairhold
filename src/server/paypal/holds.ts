/**
 * The two ends of the PayPal window: after approval, authorize the order and make it the paddle's
 * bidding power (or, when it may not replace the hold in place, release it again); after a cancel,
 * mark the hold canceled. Both are idempotent, because the return page can be reloaded and the
 * CHECKOUT.ORDER.APPROVED webhook may run the same approval as a backstop.
 */
import { createPostgresHoldStore, type HoldRecord, type HoldRefusal, type HoldStore } from "./hold-store";
import { PaypalError } from "./errors";
import { paypalRequestId } from "./idempotency";
import type { AuthorizedOrder, HoldKind, Payments } from "./payments";
import { getPayments } from "./runtime";

export const HONOR_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;

const VOID_ATTEMPTS = 3;
const VOID_BACKOFF_MS = 400;

export interface HoldFlowDependencies {
  store: HoldStore;
  paymentsFor: (kind: HoldKind) => Payments;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export interface HoldWindowRequest {
  holdId: string;
  /** The `token` PayPal appends to the return and cancel URLs: the order id. */
  orderId: string | null;
}

export type ApprovalOutcome =
  | { kind: "authorized"; hold: HoldRecord; alreadyAuthorized: boolean }
  /** PayPal has not finished, or the buyer still has a step to take on PayPal's page. */
  | { kind: "pending"; hold: HoldRecord; error: PaypalError | null }
  | { kind: "declined" | "failed"; hold: HoldRecord; error: PaypalError }
  /**
   * PayPal authorized it, but it may not become the bidding power (holdSwapRefusal): the hold in
   * place stays, and this authorization is voided (hold status voided, or replaced while the
   * void is still owed).
   */
  | { kind: "refused"; hold: HoldRecord; refusal: HoldRefusal }
  | { kind: "not_pending" | "order_mismatch"; hold: HoldRecord }
  | { kind: "not_found" };

export type CancelOutcome =
  | { kind: "canceled" | "not_pending" | "order_mismatch"; hold: HoldRecord }
  | { kind: "not_found" };

/** The buyer's funding was refused: nothing is held, and trying again needs a new approval. */
const DECLINE_CODES: ReadonlySet<string> = new Set([
  "INSTRUMENT_DECLINED",
  "PAYER_CANNOT_PAY",
  "PAYMENT_DENIED",
  "TRANSACTION_REFUSED",
  "PAYER_ACCOUNT_RESTRICTED",
  "PAYER_ACCOUNT_LOCKED_OR_CLOSED",
  "AUTHORIZATION_DENIED",
]);

/**
 * Not final: the buyer has a step left at PayPal, or an earlier authorize went through but was
 * never stored and PayPal stopped replaying it (orders keep request ids for 6 hours). The
 * PAYMENT.AUTHORIZATION.CREATED webhook, whose custom_id is the hold id, settles those.
 */
const UNSETTLED_CODES: ReadonlySet<string> = new Set([
  "ORDER_NOT_APPROVED",
  "PAYER_ACTION_REQUIRED",
  "ORDER_ALREADY_AUTHORIZED",
]);

export async function completeHoldApproval(
  request: HoldWindowRequest,
  dependencies: HoldFlowDependencies = defaultDependencies(),
): Promise<ApprovalOutcome> {
  const { store } = dependencies;
  const hold = await store.findHold(request.holdId);
  if (!hold) return { kind: "not_found" };
  if (isOtherOrder(hold, request.orderId)) return { kind: "order_mismatch", hold };
  if (hold.status === "authorized") return { kind: "authorized", hold, alreadyAuthorized: true };
  if (hold.status !== "pending_approval" || !hold.paypalOrderId) return { kind: "not_pending", hold };

  let authorized: AuthorizedOrder;
  try {
    authorized = await dependencies.paymentsFor(hold.kind).authorizeOrder({
      orderId: hold.paypalOrderId,
      idempotencyKey: paypalRequestId("authorize-order", hold.id),
    });
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    return recordApprovalFailure(hold, error, store);
  }

  const { authorization } = authorized;
  if (authorization.status === "PENDING") {
    // Held for PayPal review; the authorization webhook completes it.
    return { kind: "pending", hold, error: null };
  }
  if (authorization.status !== "CREATED") {
    const error = new PaypalError({
      operation: "authorizeOrder",
      code: `AUTHORIZATION_${authorization.status}`,
      debugId: authorized.debugId,
    });
    return recordApprovalFailure(hold, error, store);
  }
  if (authorization.amountCents !== hold.amountCents) {
    console.warn(
      `[paypal] hold ${hold.id} asked for ${hold.amountCents} cents and PayPal authorized ${authorization.amountCents}; keeping PayPal's amount`,
    );
  }

  // PayPal's authorization time, not ours: a webhook backstop may get here hours later.
  const authorizedAt = authorization.createdAt ?? dependencies.now();
  const stored = await store.markAuthorized(hold.id, {
    authorizationId: authorization.authorizationId,
    amountCents: authorization.amountCents,
    authorizedAt,
    honorUntil: new Date(authorizedAt.getTime() + HONOR_PERIOD_MS),
    expiresAt: authorization.expiresAt ?? null,
    payer: authorized.payer,
    raw: authorized.raw,
  });

  if (stored.kind === "not_pending") {
    // Another delivery of the same approval stored the same authorization first.
    if (stored.status === "authorized") return { kind: "authorized", hold, alreadyAuthorized: true };
    // Canceled while PayPal was authorizing: nothing may stay held for this hold.
    await releaseAuthorization(hold.id, hold.kind, authorization.authorizationId, dependencies);
    return { kind: "not_pending", hold };
  }

  const withAuthorization: HoldRecord = {
    ...hold,
    amountCents: authorization.amountCents,
    originalAuthorizationId: authorization.authorizationId,
    currentAuthorizationId: authorization.authorizationId,
  };

  if (stored.kind === "refused") {
    // The bidding power stays as it was, so nothing may stay held for this approval.
    const released = await releaseAuthorization(hold.id, hold.kind, authorization.authorizationId, dependencies);
    if (released) await store.markReplacedVoided(hold.id);
    return {
      kind: "refused",
      refusal: stored.refusal,
      hold: { ...withAuthorization, status: released ? "voided" : "replaced" },
    };
  }

  const { replaced } = stored;
  if (replaced) {
    const released =
      !replaced.originalAuthorizationId ||
      (await releaseAuthorization(replaced.id, replaced.kind, replaced.originalAuthorizationId, dependencies));
    if (released) await store.markReplacedVoided(replaced.id);
  }

  return { kind: "authorized", alreadyAuthorized: false, hold: { ...withAuthorization, status: "authorized" } };
}

export async function cancelHoldApproval(
  request: HoldWindowRequest,
  dependencies: Pick<HoldFlowDependencies, "store"> = defaultDependencies(),
): Promise<CancelOutcome> {
  const hold = await dependencies.store.findHold(request.holdId);
  if (!hold) return { kind: "not_found" };
  if (isOtherOrder(hold, request.orderId)) return { kind: "order_mismatch", hold };
  if (hold.status !== "pending_approval") return { kind: "not_pending", hold };
  const canceled = await dependencies.store.markCanceled(hold.id);
  return canceled ? { kind: "canceled", hold: { ...hold, status: "canceled" } } : { kind: "not_pending", hold };
}

async function recordApprovalFailure(hold: HoldRecord, error: PaypalError, store: HoldStore): Promise<ApprovalOutcome> {
  if (error.retryable || UNSETTLED_CODES.has(error.code)) {
    await store.recordPaypalError(hold.id, error.toRecord());
    return { kind: "pending", hold, error };
  }
  const declined = DECLINE_CODES.has(error.code);
  await store.markApprovalFailed(hold.id, declined ? "denied" : "failed", error.toRecord());
  console.error(`[paypal] authorizing hold ${hold.id} failed: ${error.message}`);
  return { kind: declined ? "declined" : "failed", hold, error };
}

/**
 * Voids an authorization on its original id, retrying transient failures with the same request
 * id. Returns false while it is still live; the failure stays recorded on the hold for the sweep.
 */
async function releaseAuthorization(
  holdId: string,
  kind: HoldKind,
  authorizationId: string,
  dependencies: HoldFlowDependencies,
): Promise<boolean> {
  const request = { authorizationId, idempotencyKey: paypalRequestId("void", holdId) };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dependencies.paymentsFor(kind).void(request);
      return true;
    } catch (error) {
      if (error instanceof PaypalError && error.is("PREVIOUSLY_VOIDED")) return true;
      if (error instanceof PaypalError && error.retryable && attempt < VOID_ATTEMPTS) {
        await dependencies.sleep(VOID_BACKOFF_MS * attempt);
        continue;
      }
      const record =
        error instanceof PaypalError
          ? error.toRecord()
          : { operation: "void" as const, code: "UNKNOWN", httpStatus: null, debugId: null };
      await dependencies.store.recordPaypalError(holdId, record);
      console.error(`[paypal] voiding the authorization of hold ${holdId} failed:`, error);
      return false;
    }
  }
}

function isOtherOrder(hold: HoldRecord, orderId: string | null): boolean {
  return orderId !== null && hold.paypalOrderId !== null && orderId !== hold.paypalOrderId;
}

function defaultDependencies(): HoldFlowDependencies {
  return {
    store: createPostgresHoldStore(),
    paymentsFor: getPayments,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
