/**
 * Typed PayPal failures. Every error that leaves this folder is a PaypalError carrying the
 * operation, PayPal's issue code and its debug_id, so callers can store them and decide what to
 * do from the code alone.
 */

export type PaymentsOperation =
  | "authenticate"
  | "createAuthorizeOrder"
  | "authorizeOrder"
  | "getAuthorization"
  | "capture"
  | "void"
  | "reauthorize"
  | "verifyWebhookSignature";

/**
 * Issue codes the app reacts to (PayPal's error catalogs for Orders v2 and Payments v2). PayPal
 * sends many more; those pass through unchanged as `code`.
 */
export const PAYPAL_ISSUES = [
  // The buyer's funding was refused.
  "INSTRUMENT_DECLINED",
  "PAYER_ACTION_REQUIRED",
  "PAYER_CANNOT_PAY",
  "PAYMENT_DENIED",
  "TRANSACTION_REFUSED",
  // Order authorization.
  "ORDER_NOT_APPROVED",
  "ORDER_ALREADY_AUTHORIZED",
  "ORDER_EXPIRED",
  "ORDER_COMPLETED_OR_VOIDED",
  "ORDER_AUTHORIZATION_IN_PROGRESS",
  "AUTH_CAPTURE_NOT_ENABLED",
  // Capture.
  "AUTHORIZATION_EXPIRED",
  "AUTHORIZATION_VOIDED",
  "AUTHORIZATION_DENIED",
  "AUTHORIZATION_ALREADY_CAPTURED",
  "MAX_CAPTURE_AMOUNT_EXCEEDED",
  "DUPLICATE_INVOICE_ID",
  // Void refusals.
  "CANNOT_BE_VOIDED",
  "PREVIOUSLY_VOIDED",
  "PREVIOUSLY_CAPTURED",
  // Reauthorize refusals.
  "REAUTHORIZATION_NOT_SUPPORTED",
  "REAUTHORIZATION_TOO_SOON",
  "AUTHORIZATION_AMOUNT_EXCEEDED",
  "REAUTHORIZATION_DECLINED_BY_PROCESSOR",
  // Concurrency, access and transport.
  "PREVIOUS_REQUEST_IN_PROGRESS",
  "INVALID_RESOURCE_ID",
  "RESOURCE_NOT_FOUND",
  "AUTHENTICATION_FAILURE",
  "NOT_AUTHORIZED",
  "PERMISSION_DENIED",
  "INTERNAL_SERVER_ERROR",
  "NETWORK_ERROR",
  "TIMEOUT",
  "UNEXPECTED_RESPONSE",
  "UNKNOWN",
] as const;

export type PaypalIssue = (typeof PAYPAL_ISSUES)[number];

/** A known issue, or any other code PayPal sends. */
export type PaypalErrorCode = PaypalIssue | (string & {});

export interface PaypalErrorDetail {
  issue?: string;
  description?: string;
  field?: string;
  location?: string;
}

export interface PaypalErrorInit {
  operation: PaymentsOperation;
  code: PaypalErrorCode;
  message?: string;
  paypalName?: string;
  httpStatus?: number;
  debugId?: string;
  details?: readonly PaypalErrorDetail[];
  cause?: unknown;
}

/**
 * Codes that are safe to retry with the same PayPal-Request-Id: the outcome was not decided, or
 * PayPal is still working on the first request.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "PREVIOUS_REQUEST_IN_PROGRESS",
  "ORDER_AUTHORIZATION_IN_PROGRESS",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "RATE_LIMIT_REACHED",
  "NETWORK_ERROR",
  "TIMEOUT",
]);

export class PaypalError extends Error {
  override name = "PaypalError";
  readonly operation: PaymentsOperation;
  readonly code: PaypalErrorCode;
  /** PayPal's error name, such as UNPROCESSABLE_ENTITY; `code` is the specific issue. */
  readonly paypalName: string | undefined;
  readonly httpStatus: number | undefined;
  readonly debugId: string | undefined;
  readonly details: readonly PaypalErrorDetail[];
  readonly retryable: boolean;

  constructor(init: PaypalErrorInit) {
    super(init.message ?? describe(init), init.cause === undefined ? undefined : { cause: withoutRequest(init.cause) });
    this.operation = init.operation;
    this.code = init.code;
    this.paypalName = init.paypalName;
    this.httpStatus = init.httpStatus;
    this.debugId = init.debugId;
    this.details = init.details ?? [];
    this.retryable =
      RETRYABLE_CODES.has(init.code) ||
      (init.httpStatus !== undefined &&
        (init.httpStatus >= 500 || init.httpStatus === 429 || init.httpStatus === 408));
  }

  is(...codes: PaypalIssue[]): boolean {
    return (codes as readonly string[]).includes(this.code);
  }

  /** What to persist next to the hold or settlement item (no secrets, no payload). */
  toRecord(): { operation: PaymentsOperation; code: string; httpStatus: number | null; debugId: string | null } {
    return {
      operation: this.operation,
      code: this.code,
      httpStatus: this.httpStatus ?? null,
      debugId: this.debugId ?? null,
    };
  }
}

/**
 * The SDK's errors carry the request they answer, Authorization header included: the bearer
 * token, or the client id and secret on a token request. The cause keeps only the name, message,
 * code and stack of each error in its chain, so printing or storing a PaypalError at any depth
 * cannot leak credentials.
 */
function withoutRequest(cause: unknown, depth = 0): Error {
  if (!(cause instanceof Error)) return new Error(typeof cause === "string" ? cause : "non-Error value thrown");
  const copy = new Error(cause.message);
  copy.name = cause.name;
  if (cause.stack !== undefined) copy.stack = cause.stack;
  const code = (cause as { code?: unknown }).code;
  if (typeof code === "string") Object.assign(copy, { code });
  if (cause.cause !== undefined && depth < 4) copy.cause = withoutRequest(cause.cause, depth + 1);
  return copy;
}

function describe(init: PaypalErrorInit): string {
  const status = init.httpStatus === undefined ? "" : ` (HTTP ${init.httpStatus})`;
  const debug = init.debugId === undefined ? "" : `, debug_id ${init.debugId}`;
  return `PayPal ${init.operation} failed: ${init.code}${status}${debug}`;
}

interface PaypalErrorBody {
  name?: unknown;
  message?: unknown;
  debug_id?: unknown;
  details?: unknown;
  // OAuth errors use the RFC 6749 shape instead.
  error?: unknown;
  error_description?: unknown;
}

/** The fields of an HTTP error response that the mapping needs. */
export interface HttpErrorResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

/** Maps a PayPal HTTP error response (any status outside 2xx) to a PaypalError. */
export function paypalErrorFromResponse(
  operation: PaymentsOperation,
  response: HttpErrorResponse,
  cause?: unknown,
): PaypalError {
  const body = parseErrorBody(response.body);
  const details = Array.isArray(body?.details) ? body.details.filter(isDetail) : [];
  const issue = details.find((detail) => typeof detail.issue === "string")?.issue;
  const paypalName = stringOrUndefined(body?.name);
  const oauthError = stringOrUndefined(body?.error);

  let code: string;
  if (issue) code = issue;
  else if (oauthError) code = response.status === 401 ? "AUTHENTICATION_FAILURE" : oauthError.toUpperCase();
  else if (paypalName) code = paypalName;
  else if (response.status === 401) code = "AUTHENTICATION_FAILURE";
  else if (response.status === 404) code = "RESOURCE_NOT_FOUND";
  else if (response.status >= 500) code = "INTERNAL_SERVER_ERROR";
  else code = `HTTP_${response.status}`;

  return new PaypalError({
    operation,
    code,
    paypalName,
    httpStatus: response.status,
    debugId: stringOrUndefined(body?.debug_id) ?? headerValue(response.headers, "paypal-debug-id"),
    details,
    cause,
  });
}

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ERR_NETWORK",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set(["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"]);

/**
 * Maps a failure that has no PayPal response (socket errors, timeouts) or an unexpected exception.
 * A transport failure after the request left leaves the outcome unknown, which is why it is
 * retryable: the retry carries the same PayPal-Request-Id and cannot apply twice.
 */
export function paypalErrorFromException(operation: PaymentsOperation, error: unknown): PaypalError {
  if (error instanceof PaypalError) return error;
  const code = errorCode(error) ?? errorCode(error instanceof Error ? error.cause : undefined);
  const name = error instanceof Error ? error.name : undefined;

  if (name === "TimeoutError" || name === "AbortError" || (code && TIMEOUT_ERROR_CODES.has(code))) {
    return new PaypalError({ operation, code: "TIMEOUT", cause: error });
  }
  if ((code && NETWORK_ERROR_CODES.has(code)) || isFetchNetworkFailure(error)) {
    return new PaypalError({ operation, code: "NETWORK_ERROR", cause: error });
  }
  return new PaypalError({ operation, code: "UNKNOWN", cause: error });
}

export function unexpectedResponse(operation: PaymentsOperation, problem: string, debugId?: string): PaypalError {
  return new PaypalError({
    operation,
    code: "UNEXPECTED_RESPONSE",
    message: `PayPal ${operation} returned an unexpected response: ${problem}`,
    debugId,
  });
}

function parseErrorBody(body: unknown): PaypalErrorBody | undefined {
  if (body && typeof body === "object") return body as PaypalErrorBody;
  if (typeof body !== "string" || body.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" ? (parsed as PaypalErrorBody) : undefined;
  } catch {
    return undefined;
  }
}

function isDetail(value: unknown): value is PaypalErrorDetail {
  return value !== null && typeof value === "object";
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && value !== "") return value;
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Node's fetch reports socket failures as a TypeError("fetch failed") with the cause attached. */
function isFetchNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError && error.message === "fetch failed";
}
