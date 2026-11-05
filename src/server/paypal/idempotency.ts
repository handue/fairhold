import { createHash } from "node:crypto";

/**
 * PayPal-Request-Id values. PayPal replays the stored result when a POST repeats with the same id
 * (orders keep ids for 6 hours, payments for 45 days), so a retry after a timeout or a crash can
 * never authorize, capture or void twice. The id must be derived, not random: the retry has to
 * produce the same one.
 */

export type PaypalRequestScope =
  | "create-order"
  | "authorize-order"
  | "capture"
  | "void"
  | "reauthorize"
  | "verify-webhook";

/** PayPal's idempotency guide limits the header to 38 single-byte characters (a UUID is 36). */
export const MAX_REQUEST_ID_LENGTH = 38;

const FAIRHOLD_NAMESPACE = "04e8a74d-e978-48e5-a182-8add3c355b60";

/**
 * The request id for one operation on one subject: the hold id (create, authorize, void,
 * reauthorize) or the settlement item id (capture and settlement voids). Automatic retries reuse
 * attempt 1; a deliberate new attempt after a final failure, such as an organizer's retry after a
 * declined capture, passes the next attempt number so PayPal treats it as a new request.
 */
export function paypalRequestId(scope: PaypalRequestScope, subjectId: string, attempt = 1): string {
  if (subjectId === "") throw new RangeError("paypalRequestId needs a subject id");
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RangeError(`attempt must be a positive integer, got ${attempt}`);
  }
  const name = attempt === 1 ? `${scope}:${subjectId}` : `${scope}:${subjectId}:attempt-${attempt}`;
  return nameBasedUuid(name, FAIRHOLD_NAMESPACE);
}

export function assertRequestId(requestId: string): void {
  if (requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH || /\s/.test(requestId)) {
    throw new RangeError(
      `PayPal-Request-Id must be 1-${MAX_REQUEST_ID_LENGTH} characters without spaces; use paypalRequestId()`,
    );
  }
}

/** RFC 9562 version 5 (SHA-1, name-based) UUID. */
export function nameBasedUuid(name: string, namespace: string): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  if (namespaceBytes.length !== 16) throw new RangeError(`not a UUID: ${namespace}`);
  const bytes = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
