import { describe, expect, it } from "vitest";

import { paypalRequestId } from "@/server/paypal/idempotency";
import { isSimulatedId, paypalIdOrNull } from "@/server/paypal/simulated-ids";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

describe("telling simulated payments' ids from PayPal's", () => {
  it("recognizes every id simulated payments makes for a hold and its charge", async () => {
    const payments = new SimulatedPayments(createSimulatedPaypalState(), () => new Date("2026-11-09T20:00:00Z"));
    const order = await payments.createAuthorizeOrder({
      holdId: "hold-1",
      amountCents: 500_00,
      description: "Bidding power",
      softDescriptor: "RIVERSIDEGALA",
      returnUrl: "https://fairhold.example/paypal/return?hold=hold-1",
      cancelUrl: "https://fairhold.example/paypal/cancel?hold=hold-1",
      idempotencyKey: paypalRequestId("create-order", "hold-1"),
    });
    const { authorization } = await payments.authorizeOrder({ orderId: order.orderId, idempotencyKey: paypalRequestId("authorize-order", "hold-1") });
    const capture = await payments.capture({
      authorizationId: authorization.authorizationId,
      amountCents: 310_00,
      invoiceId: "FH-event-1-142",
      softDescriptor: "RIVERSIDEGALA",
      noteToPayer: "Thank you.",
      idempotencyKey: paypalRequestId("capture", "item-1"),
    });

    for (const id of [order.orderId, authorization.authorizationId, capture.captureId]) {
      expect(isSimulatedId(id)).toBe(true);
      expect(paypalIdOrNull(id)).toBeNull();
    }
  });

  it("keeps PayPal's own ids, including one that happens to start with SIM", () => {
    for (const id of ["7HX40418TL552863B", "3U222770MA387621Y", "SIMPLE0000000000X", "SIMC1ED2FF3B27A4"]) {
      expect(isSimulatedId(id)).toBe(false);
      expect(paypalIdOrNull(id)).toBe(id);
    }
    expect(paypalIdOrNull(null)).toBeNull();
    expect(paypalIdOrNull(undefined)).toBeNull();
  });
});
