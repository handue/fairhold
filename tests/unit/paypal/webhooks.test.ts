import { describe, expect, it, vi } from "vitest";

import { PaypalError } from "@/server/paypal/errors";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { PaypalSandboxClient } from "@/server/paypal/sandbox-client";
import type { WebhookEventStore } from "@/server/paypal/webhook-event-store";
import {
  createWebhookSignatureVerifier,
  MAX_WEBHOOK_BODY_BYTES,
  receivePaypalWebhook,
  verificationRequestBody,
  type WebhookDependencies,
  type WebhookEvent,
  type WebhookSignatureVerifier,
  type WebhookTransmission,
} from "@/server/paypal/webhooks";

import { bodyOf, FakePaypal, json } from "./fake-paypal";

// Key order, spacing and number format as PayPal might send them; none of it may change.
const RAW_EVENT = `{"id":"WH-7Y7254563A4550640-11V2185806837105M","event_version":"1.0",
  "create_time":"2026-11-04T21:00:00.000Z","resource_type":"authorization","event_type":"PAYMENT.AUTHORIZATION.VOIDED",
  "summary":"A payment authorization was voided","resource":{"id":"AUTH1","status":"VOIDED","amount":{"value":"500.00","currency_code":"USD"},"custom_id":"hold-1"},
  "links":[], "x":1.50}`;

const TRANSMISSION: WebhookTransmission = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  transmissionId: "103e3700-8b0c-11ef-8f4f-3b5d1d8a2c8e",
  transmissionSig: "c2lnbmF0dXJl",
  transmissionTime: "2026-11-04T21:00:01Z",
};

function deliveryHeaders(overrides: Record<string, string | null> = {}): Headers {
  const headers = new Headers({
    "paypal-auth-algo": TRANSMISSION.authAlgo,
    "paypal-cert-url": TRANSMISSION.certUrl,
    "paypal-transmission-id": TRANSMISSION.transmissionId,
    "paypal-transmission-sig": TRANSMISSION.transmissionSig,
    "paypal-transmission-time": TRANSMISSION.transmissionTime,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

class MemoryEventStore implements WebhookEventStore {
  readonly events = new Map<string, WebhookEvent>();
  async insertOnce(event: WebhookEvent): Promise<"stored" | "duplicate"> {
    if (this.events.has(event.eventId)) return "duplicate";
    this.events.set(event.eventId, event);
    return "stored";
  }
}

function dependencies(verify: WebhookSignatureVerifier["verify"] | null) {
  const store = new MemoryEventStore();
  const verifier = verify ? { verify: vi.fn(verify) } : null;
  const deps: WebhookDependencies = { verifier, store };
  return { deps, store, verifier };
}

describe("verificationRequestBody", () => {
  it("splices the event in byte for byte", () => {
    const body = verificationRequestBody(RAW_EVENT, TRANSMISSION, "8PT597110X687430LKGECATA");

    expect(body.endsWith(`"webhook_event":${RAW_EVENT}}`)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      auth_algo: TRANSMISSION.authAlgo,
      cert_url: TRANSMISSION.certUrl,
      transmission_id: TRANSMISSION.transmissionId,
      transmission_sig: TRANSMISSION.transmissionSig,
      transmission_time: TRANSMISSION.transmissionTime,
      webhook_id: "8PT597110X687430LKGECATA",
      webhook_event: JSON.parse(RAW_EVENT),
    });
  });

  it("refuses a body that could smuggle fields into the request", () => {
    expect(() => verificationRequestBody('{"id":"x"},"webhook_id":"ATTACKER"', TRANSMISSION, "ours")).toThrow(RangeError);
    expect(() => verificationRequestBody("[1,2]", TRANSMISSION, "ours")).toThrow(RangeError);
  });
});

describe("receivePaypalWebhook", () => {
  it("stores a verified event once and answers duplicates", async () => {
    const { deps, store, verifier } = dependencies(async () => true);

    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), deps)).resolves.toEqual({
      kind: "stored",
      eventId: "WH-7Y7254563A4550640-11V2185806837105M",
      eventType: "PAYMENT.AUTHORIZATION.VOIDED",
    });
    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), deps)).resolves.toMatchObject({ kind: "duplicate" });

    expect(verifier?.verify).toHaveBeenCalledWith(RAW_EVENT, TRANSMISSION);
    expect([...store.events.values()]).toEqual([
      {
        eventId: "WH-7Y7254563A4550640-11V2185806837105M",
        eventType: "PAYMENT.AUTHORIZATION.VOIDED",
        resourceType: "authorization",
        resourceId: "AUTH1",
        payload: JSON.parse(RAW_EVENT),
      },
    ]);
  });

  it("rejects an event PayPal does not vouch for, without storing it", async () => {
    const { deps, store } = dependencies(async () => false);

    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), deps)).resolves.toEqual({
      kind: "rejected",
      reason: "invalid_signature",
    });
    expect(store.events.size).toBe(0);
  });

  it("rejects malformed, oversized or unsigned deliveries before asking PayPal", async () => {
    const { deps, verifier } = dependencies(async () => true);

    await expect(receivePaypalWebhook("not json", deliveryHeaders(), deps)).resolves.toMatchObject({ reason: "malformed" });
    await expect(receivePaypalWebhook('{"event_type":"X"}', deliveryHeaders(), deps)).resolves.toMatchObject({ reason: "malformed" });
    await expect(
      receivePaypalWebhook(RAW_EVENT, deliveryHeaders({ "paypal-transmission-sig": null }), deps),
    ).resolves.toMatchObject({ reason: "missing_headers" });
    const huge = JSON.stringify({ id: "WH-1", event_type: "X", padding: "x".repeat(MAX_WEBHOOK_BODY_BYTES) });
    await expect(receivePaypalWebhook(huge, deliveryHeaders(), deps)).resolves.toMatchObject({ reason: "too_large" });

    expect(verifier?.verify).not.toHaveBeenCalled();
  });

  it("asks PayPal to deliver again when it cannot verify now", async () => {
    const unavailable = new PaypalError({ operation: "verifyWebhookSignature", code: "INTERNAL_SERVER_ERROR", httpStatus: 503 });
    const down = dependencies(async () => {
      throw unavailable;
    });
    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), down.deps)).resolves.toEqual({
      kind: "unavailable",
      reason: "verification_error",
      error: unavailable,
    });

    const unconfigured = dependencies(null);
    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), unconfigured.deps)).resolves.toEqual({
      kind: "unavailable",
      reason: "not_configured",
    });
  });

  it("rejects a delivery whose headers PayPal refuses to check", async () => {
    const refused = dependencies(async () => {
      throw new PaypalError({ operation: "verifyWebhookSignature", code: "VALIDATION_ERROR", httpStatus: 400 });
    });
    await expect(receivePaypalWebhook(RAW_EVENT, deliveryHeaders(), refused.deps)).resolves.toEqual({
      kind: "rejected",
      reason: "invalid_signature",
    });
  });
});

describe("createWebhookSignatureVerifier", () => {
  function setup(status: "SUCCESS" | "FAILURE") {
    const paypal = new FakePaypal();
    paypal.on("POST", "/v1/notifications/verify-webhook-signature", () => json(200, { verification_status: status }));
    const client = new PaypalSandboxClient({ clientId: "test-client", clientSecret: "test-secret", http: paypal.http });
    return { paypal, verifier: createWebhookSignatureVerifier(client, "8PT597110X687430LKGECATA") };
  }

  it("posts the raw body to PayPal with the shared token and a request id", async () => {
    const { paypal, verifier } = setup("SUCCESS");

    await expect(verifier.verify(RAW_EVENT, TRANSMISSION)).resolves.toBe(true);

    const request = paypal.lastRequest("/v1/notifications/verify-webhook-signature");
    expect(request.url).toBe("https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature");
    expect(request.headers.authorization).toBe("Bearer token-1");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["paypal-request-id"]).toBe(paypalRequestId("verify-webhook", TRANSMISSION.transmissionId));
    expect(request.body).toBe(verificationRequestBody(RAW_EVENT, TRANSMISSION, "8PT597110X687430LKGECATA"));
    expect(bodyOf(request)).toMatchObject({ webhook_id: "8PT597110X687430LKGECATA" });
  });

  it("answers false when PayPal says FAILURE", async () => {
    const { verifier } = setup("FAILURE");
    await expect(verifier.verify(RAW_EVENT, TRANSMISSION)).resolves.toBe(false);
  });
});
