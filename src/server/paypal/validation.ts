/**
 * Request checks shared by both payments implementations, so the simulation rejects exactly what
 * the sandbox would and a bad request fails before any HTTP call. Limits are PayPal's (Orders v2
 * and Payments v2 schemas), tightened where PayPal would silently truncate instead of failing.
 */
import { assertRequestId } from "./idempotency";
import { assertCents } from "./money";
import {
  AUTHORIZATION_STATUSES,
  CAPTURE_STATUSES,
  type AuthorizationStatus,
  type AuthorizeOrderRequest,
  type CaptureRequest,
  type CaptureStatus,
  type CreateAuthorizeOrderRequest,
  type ReauthorizeRequest,
  type VoidRequest,
} from "./payments";

/** PayPal ids are short uppercase alphanumerics; this also keeps path segments safe. */
const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;
/** PayPal allows letters, digits, dashes, asterisks, periods and spaces in a soft descriptor. */
const SOFT_DESCRIPTOR = /^[A-Za-z0-9 .*-]{1,22}$/;

export function validateCreateAuthorizeOrder(request: CreateAuthorizeOrderRequest): void {
  assertRequestId(request.idempotencyKey);
  assertPositiveCents(request.amountCents);
  if (request.amountCents % 100 !== 0) {
    throw new RangeError(`holds are whole dollars, got ${request.amountCents} cents`);
  }
  assertText("holdId", request.holdId, 255);
  // PayPal accepts more but truncates the description to 127 characters.
  assertText("description", request.description, 127);
  assertSoftDescriptor(request.softDescriptor);
  assertHttpUrl("returnUrl", request.returnUrl);
  assertHttpUrl("cancelUrl", request.cancelUrl);
}

export function validateAuthorizeOrder(request: AuthorizeOrderRequest): void {
  assertRequestId(request.idempotencyKey);
  assertResourceId("orderId", request.orderId);
}

export function validateCapture(request: CaptureRequest): void {
  assertRequestId(request.idempotencyKey);
  assertResourceId("authorizationId", request.authorizationId);
  assertPositiveCents(request.amountCents);
  assertText("invoiceId", request.invoiceId, 127);
  assertSoftDescriptor(request.softDescriptor);
  assertText("noteToPayer", request.noteToPayer, 255);
}

export function validateVoid(request: VoidRequest): void {
  assertRequestId(request.idempotencyKey);
  assertResourceId("authorizationId", request.authorizationId);
}

export function validateReauthorize(request: ReauthorizeRequest): void {
  assertRequestId(request.idempotencyKey);
  assertResourceId("authorizationId", request.authorizationId);
  assertPositiveCents(request.amountCents);
}

export function assertResourceId(label: string, id: string): void {
  if (!RESOURCE_ID.test(id)) throw new RangeError(`${label} is not a PayPal id: ${JSON.stringify(id)}`);
}

export function isAuthorizationStatus(value: unknown): value is AuthorizationStatus {
  return typeof value === "string" && (AUTHORIZATION_STATUSES as readonly string[]).includes(value);
}

export function isCaptureStatus(value: unknown): value is CaptureStatus {
  return typeof value === "string" && (CAPTURE_STATUSES as readonly string[]).includes(value);
}

function assertPositiveCents(cents: number): void {
  assertCents(cents);
  if (cents === 0) throw new RangeError("amount must be greater than zero");
}

function assertText(label: string, value: string, maxLength: number): void {
  if (value.trim() === "" || value.length > maxLength) {
    throw new RangeError(`${label} must be 1-${maxLength} characters`);
  }
}

function assertSoftDescriptor(value: string): void {
  if (!SOFT_DESCRIPTOR.test(value)) {
    throw new RangeError(
      "softDescriptor must be 1-22 characters of letters, digits, spaces, dashes, periods or asterisks",
    );
  }
}

function assertHttpUrl(label: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RangeError(`${label} must be an absolute URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RangeError(`${label} must be an http(s) URL`);
  }
}
