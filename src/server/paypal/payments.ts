/**
 * The one payments interface, with two implementations: SandboxPayments calls the PayPal sandbox
 * through @paypal/paypal-server-sdk, and SimulatedPayments is deterministic and in-process, for the
 * bots, CI and keyless local mode. Both take and return integer USD cents and throw PaypalError
 * with PayPal's issue code and debug_id. getPayments() in ./runtime picks one per hold.
 *
 * Every POST takes the caller's idempotency key (paypalRequestId() of the hold or settlement item
 * id), sent as PayPal-Request-Id.
 */
import type { PaypalIssue } from "./errors";

export type HoldKind = "paypal" | "simulated";
export type PaymentsMode = "sandbox" | "simulated";

/** The label PayPal shows the buyer instead of the merchant account's business name. */
export const PAYPAL_BRAND_NAME = "Fairhold";

export const AUTHORIZATION_STATUSES = [
  "CREATED",
  "CAPTURED",
  "DENIED",
  "PARTIALLY_CAPTURED",
  "VOIDED",
  "PENDING",
] as const;
export type AuthorizationStatus = (typeof AUTHORIZATION_STATUSES)[number];

export const CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
] as const;
export type CaptureStatus = (typeof CAPTURE_STATUSES)[number];

/** Sandbox negative testing: PayPal answers with this issue instead of processing the call. */
export type MockIssue = PaypalIssue | (string & {});

interface PostRequest {
  /** PayPal-Request-Id; derive it with paypalRequestId() so a retry sends the same one. */
  idempotencyKey: string;
  /** PayPal-Mock-Response (sandbox only). The simulated payments honor it the same way. */
  mockIssue?: MockIssue;
}

export interface CreateAuthorizeOrderRequest extends PostRequest {
  /** Sent as custom_id, so PayPal's records and webhooks lead back to the hold. */
  holdId: string;
  /** Whole dollars only. */
  amountCents: number;
  /** Shown to the buyer on the PayPal page; at most 127 characters. */
  description: string;
  /** Statement text after PayPal's prefix; at most 22 characters, e.g. RIVERSIDEGALA. */
  softDescriptor: string;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreatedOrder {
  orderId: string;
  status: string;
  /** Where the buyer approves the hold (the payer-action link). */
  payerActionUrl: string;
  debugId: string | undefined;
}

export interface AuthorizeOrderRequest extends PostRequest {
  orderId: string;
}

export interface Payer {
  payerId: string | undefined;
  email: string | undefined;
  givenName: string | undefined;
  surname: string | undefined;
}

export interface Authorization {
  authorizationId: string;
  status: AuthorizationStatus;
  amountCents: number;
  createdAt: Date | undefined;
  expiresAt: Date | undefined;
  customId: string | undefined;
}

export interface AuthorizedOrder {
  orderId: string;
  authorization: Authorization;
  payer: Payer;
  debugId: string | undefined;
  /** PayPal's response body as sent, for holds.raw. */
  raw: unknown;
}

export interface AuthorizationReadBack extends Authorization {
  debugId: string | undefined;
  raw: unknown;
}

export interface CaptureRequest extends PostRequest {
  /** The current authorization id (the newest one after a reauthorization). */
  authorizationId: string;
  amountCents: number;
  /** Unique per merchant account, e.g. FH-<event>-<paddle>. */
  invoiceId: string;
  softDescriptor: string;
  noteToPayer: string;
}

export interface Capture {
  captureId: string;
  status: CaptureStatus;
  amountCents: number;
  finalCapture: boolean;
  invoiceId: string | undefined;
  createdAt: Date | undefined;
  debugId: string | undefined;
  raw: unknown;
}

export interface VoidRequest extends PostRequest {
  /** The original authorization id: PayPal refuses to void a reauthorization (CANNOT_BE_VOIDED). */
  authorizationId: string;
}

export interface VoidResult {
  authorizationId: string;
  status: AuthorizationStatus;
  debugId: string | undefined;
}

/** PayPal does not accept PayPal-Mock-Response on reauthorize. */
export interface ReauthorizeRequest extends Omit<PostRequest, "mockIssue"> {
  /** The original authorization id: a reauthorized id returns REAUTHORIZATION_NOT_SUPPORTED. */
  authorizationId: string;
  amountCents: number;
}

/** The new authorization; its id becomes the hold's current id. */
export interface Reauthorization extends Authorization {
  debugId: string | undefined;
  raw: unknown;
}

export interface Payments {
  readonly mode: PaymentsMode;
  /** POST /v2/checkout/orders with intent AUTHORIZE; returns the payer-action URL. */
  createAuthorizeOrder(request: CreateAuthorizeOrderRequest): Promise<CreatedOrder>;
  /** POST /v2/checkout/orders/{id}/authorize, after the buyer approved. */
  authorizeOrder(request: AuthorizeOrderRequest): Promise<AuthorizedOrder>;
  /** GET /v2/payments/authorizations/{id}. */
  getAuthorization(authorizationId: string): Promise<AuthorizationReadBack>;
  /** POST /v2/payments/authorizations/{id}/capture with final_capture true, releasing the rest. */
  capture(request: CaptureRequest): Promise<Capture>;
  /** POST /v2/payments/authorizations/{id}/void. */
  void(request: VoidRequest): Promise<VoidResult>;
  /** POST /v2/payments/authorizations/{id}/reauthorize. */
  reauthorize(request: ReauthorizeRequest): Promise<Reauthorization>;
}
