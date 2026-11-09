/**
 * Review finding (wave 2, already a known gap in docs/status/day2.md): the verify call's
 * PayPal-Request-Id comes from the transmission id alone. If PayPal honors the header there, a forged
 * body sent under a transmission id it has already verified gets the stored SUCCESS back, and the forged
 * event is stored as verified. The key must also cover the body. Until the fix, this fails.
 */
import { describe, expect, it, vi } from "vitest";

import type { PaypalSandboxClient } from "@/server/paypal/sandbox-client";
import { createWebhookSignatureVerifier, type WebhookTransmission } from "@/server/paypal/webhooks";

const TRANSMISSION: WebhookTransmission = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  transmissionId: "transmission-1",
  transmissionSig: "signature",
  transmissionTime: "2026-11-08T05:00:00Z",
};

describe("verifying a webhook signature", () => {
  it("sends a different request id for a different body under the same transmission id", async () => {
    const postJson = vi.fn(async () => ({ status: 200, body: JSON.stringify({ verification_status: "SUCCESS" }), headers: {} }));
    const verifier = createWebhookSignatureVerifier({ postJson } as unknown as PaypalSandboxClient, "WEBHOOK-ID");

    await verifier.verify(JSON.stringify({ id: "WH-REAL", event_type: "PAYMENT.CAPTURE.DENIED" }), TRANSMISSION);
    await verifier.verify(JSON.stringify({ id: "WH-FORGED", event_type: "PAYMENT.CAPTURE.COMPLETED" }), TRANSMISSION);

    const requestIds = (postJson.mock.calls as unknown as unknown[][]).map(
      (call) => (call[3] as Record<string, string>)["paypal-request-id"],
    );
    expect(requestIds[0]).toBeDefined();
    expect(requestIds[1]).not.toBe(requestIds[0]);
  });
});
