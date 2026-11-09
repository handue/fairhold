/**
 * PayPal webhook intake: verify every delivery with POST /v1/notifications/verify-webhook-signature
 * built from the raw body, then store it once by event id. Applying events to holds and settlement
 * items is a separate step; API responses stay the source of truth and webhooks only reconcile.
 */
import { createHash } from "node:crypto";

import { z } from "zod";

import { getServerEnv } from "@/server/lib/env";

import { PaypalError } from "./errors";
import { paypalRequestId } from "./idempotency";
import { getSandboxClient } from "./runtime";
import type { PaypalSandboxClient } from "./sandbox-client";
import { createPostgresWebhookEventStore, type WebhookEventStore } from "./webhook-event-store";

/** PayPal events are a few kilobytes; anything near this is not from PayPal. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export interface WebhookTransmission {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

export interface WebhookEvent {
  eventId: string;
  eventType: string;
  resourceType: string | null;
  resourceId: string | null;
  /** The event exactly as PayPal sent it, parsed. */
  payload: Record<string, unknown>;
}

export interface WebhookSignatureVerifier {
  /** True only when PayPal answers SUCCESS for this exact body and these headers. */
  verify(rawBody: string, transmission: WebhookTransmission): Promise<boolean>;
}

export type WebhookOutcome =
  | { kind: "stored" | "duplicate"; eventId: string; eventType: string }
  | { kind: "rejected"; reason: "too_large" | "malformed" | "missing_headers" | "invalid_signature" }
  | { kind: "unavailable"; reason: "not_configured" | "verification_error"; error?: PaypalError };

export interface WebhookDependencies {
  /** Null when PayPal credentials or PAYPAL_WEBHOOK_ID are missing. */
  verifier: WebhookSignatureVerifier | null;
  store: WebhookEventStore;
}

const eventEnvelope = z.object({
  id: z.string().min(1).max(255),
  event_type: z.string().min(1).max(255),
  resource_type: z.string().max(255).optional(),
  resource: z.object({ id: z.string().max(255).optional() }).optional(),
});

export async function receivePaypalWebhook(
  rawBody: string,
  headers: Headers,
  dependencies: WebhookDependencies = defaultWebhookDependencies(),
): Promise<WebhookOutcome> {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) return { kind: "rejected", reason: "too_large" };

  const event = parseEvent(rawBody);
  if (!event) return { kind: "rejected", reason: "malformed" };

  const transmission = readTransmission(headers);
  if (!transmission) return { kind: "rejected", reason: "missing_headers" };

  if (!dependencies.verifier) return { kind: "unavailable", reason: "not_configured" };

  let verified: boolean;
  try {
    verified = await dependencies.verifier.verify(rawBody, transmission);
  } catch (error) {
    if (!(error instanceof PaypalError)) throw error;
    // PayPal refusing to check these headers is a bad delivery; anything else is on our side or
    // PayPal's, and a non-2xx answer makes PayPal deliver again later.
    const isRefusal = error.httpStatus !== undefined && error.httpStatus >= 400 && error.httpStatus < 500 &&
      error.httpStatus !== 401 && error.httpStatus !== 429;
    return isRefusal
      ? { kind: "rejected", reason: "invalid_signature" }
      : { kind: "unavailable", reason: "verification_error", error };
  }
  if (!verified) return { kind: "rejected", reason: "invalid_signature" };

  const result = await dependencies.store.insertOnce(event);
  return { kind: result, eventId: event.eventId, eventType: event.eventType };
}

export function createWebhookSignatureVerifier(
  client: PaypalSandboxClient,
  webhookId: string,
): WebhookSignatureVerifier {
  return {
    async verify(rawBody, transmission) {
      const body = verificationRequestBody(rawBody, transmission, webhookId);
      const response = await client.postJson(
        "verifyWebhookSignature",
        "/v1/notifications/verify-webhook-signature",
        body,
        { "paypal-request-id": verificationRequestId(body) },
      );
      let status: unknown;
      try {
        status = (JSON.parse(response.body) as { verification_status?: unknown }).verification_status;
      } catch {
        status = undefined;
      }
      return status === "SUCCESS";
    },
  };
}

/**
 * Keyed on everything PayPal checks, not only the transmission id. PayPal replays a repeated request
 * id, so a forged body under an id it has verified must not get that stored SUCCESS back. A real
 * redelivery is byte for byte the same, so its retries still share the id.
 */
export function verificationRequestId(verificationBody: string): string {
  return paypalRequestId("verify-webhook", createHash("sha256").update(verificationBody).digest("hex"));
}

/**
 * The verification request with the event spliced in byte for byte. PayPal checks the signature
 * against the body it sent, so a re-serialized event (other key order, spacing or number format)
 * can fail a genuine delivery. Splicing is only safe for a body that parses as one JSON object;
 * anything else could smuggle extra fields such as a second webhook_id into the request.
 */
export function verificationRequestBody(
  rawBody: string,
  transmission: WebhookTransmission,
  webhookId: string,
): string {
  if (!isJsonObject(rawBody)) throw new RangeError("the webhook body is not a single JSON object");
  const fields = JSON.stringify({
    auth_algo: transmission.authAlgo,
    cert_url: transmission.certUrl,
    transmission_id: transmission.transmissionId,
    transmission_sig: transmission.transmissionSig,
    transmission_time: transmission.transmissionTime,
    webhook_id: webhookId,
  });
  return `${fields.slice(0, -1)},"webhook_event":${rawBody}}`;
}

export function readTransmission(headers: Headers): WebhookTransmission | null {
  const transmission = {
    authAlgo: headers.get("paypal-auth-algo"),
    certUrl: headers.get("paypal-cert-url"),
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionSig: headers.get("paypal-transmission-sig"),
    transmissionTime: headers.get("paypal-transmission-time"),
  };
  for (const value of Object.values(transmission)) {
    if (!value || value.length > 2000) return null;
  }
  return transmission as WebhookTransmission;
}

function parseEvent(rawBody: string): WebhookEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const envelope = eventEnvelope.safeParse(payload);
  if (!envelope.success || !isPlainObject(payload)) return null;
  return {
    eventId: envelope.data.id,
    eventType: envelope.data.event_type,
    resourceType: envelope.data.resource_type ?? null,
    resourceId: envelope.data.resource?.id ?? null,
    payload,
  };
}

function isJsonObject(text: string): boolean {
  try {
    return isPlainObject(JSON.parse(text));
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultWebhookDependencies(): WebhookDependencies {
  const webhookId = getServerEnv().PAYPAL_WEBHOOK_ID;
  const client = getSandboxClient();
  return {
    verifier: client && webhookId ? createWebhookSignatureVerifier(client, webhookId) : null,
    store: createPostgresWebhookEventStore(),
  };
}
