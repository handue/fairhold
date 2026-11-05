import { describe, expect, it } from "vitest";

import { PaypalError } from "@/server/paypal/errors";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { CaptureRequest } from "@/server/paypal/payments";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date("2026-11-04T20:00:00Z");

function setup() {
  let now = START.getTime();
  const payments = new SimulatedPayments(createSimulatedPaypalState(), () => new Date(now));
  return {
    payments,
    advance(days: number) {
      now += days * DAY_MS;
    },
  };
}

async function authorizedHold(payments: SimulatedPayments, holdId = "hold-1", amountCents = 500_00) {
  const order = await payments.createAuthorizeOrder({
    holdId,
    amountCents,
    description: "Bidding power",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `https://fairhold.example/paypal/return?hold=${holdId}`,
    cancelUrl: `https://fairhold.example/paypal/cancel?hold=${holdId}`,
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  const authorized = await payments.authorizeOrder({
    orderId: order.orderId,
    idempotencyKey: paypalRequestId("authorize-order", holdId),
  });
  return { order, authorization: authorized.authorization, authorized };
}

function captureOf(authorizationId: string, overrides: Partial<CaptureRequest> = {}): CaptureRequest {
  return {
    authorizationId,
    amountCents: 320_00,
    invoiceId: "FH-event-1-142",
    softDescriptor: "RIVERSIDEGALA",
    noteToPayer: "Thank you.",
    idempotencyKey: paypalRequestId("capture", "item-1"),
    ...overrides,
  };
}

async function refusal(promise: Promise<unknown>): Promise<PaypalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaypalError);
    return error as PaypalError;
  }
  throw new Error("expected a PaypalError");
}

describe("SimulatedPayments", () => {
  it("approves instantly: the payer-action URL is the return URL with PayPal's parameters", async () => {
    const { payments } = setup();
    const { order, authorization, authorized } = await authorizedHold(payments);

    const approval = new URL(order.payerActionUrl);
    expect(`${approval.origin}${approval.pathname}`).toBe("https://fairhold.example/paypal/return");
    expect(approval.searchParams.get("hold")).toBe("hold-1");
    expect(approval.searchParams.get("token")).toBe(order.orderId);
    expect(authorization).toEqual({
      authorizationId: expect.stringMatching(/^SIMA[0-9A-F]{13}$/),
      status: "CREATED",
      amountCents: 500_00,
      createdAt: START,
      expiresAt: new Date(START.getTime() + 29 * DAY_MS),
      customId: "hold-1",
    });
    expect(authorized.payer.email).toMatch(/\.invalid$/);
  });

  it("derives the same ids from the same request ids in every process", async () => {
    const first = await authorizedHold(setup().payments);
    const second = await authorizedHold(setup().payments);
    expect(second.order.orderId).toBe(first.order.orderId);
    expect(second.authorization.authorizationId).toBe(first.authorization.authorizationId);
  });

  it("captures the won total once and replays the stored capture for the same request id", async () => {
    const { payments } = setup();
    const { authorization } = await authorizedHold(payments);

    const capture = await payments.capture(captureOf(authorization.authorizationId));
    const replay = await payments.capture(captureOf(authorization.authorizationId));
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 320_00, finalCapture: true });
    expect(replay).toEqual(capture);
    await expect(payments.getAuthorization(authorization.authorizationId)).resolves.toMatchObject({ status: "CAPTURED" });

    const second = await refusal(
      payments.capture(captureOf(authorization.authorizationId, { idempotencyKey: paypalRequestId("capture", "item-1", 2) })),
    );
    expect(second.code).toBe("AUTHORIZATION_ALREADY_CAPTURED");
  });

  it("refuses captures PayPal refuses", async () => {
    const { payments, advance } = setup();
    const { authorization } = await authorizedHold(payments);
    const id = authorization.authorizationId;

    expect((await refusal(payments.capture(captureOf(id, { amountCents: 600_00 })))).code).toBe("MAX_CAPTURE_AMOUNT_EXCEEDED");

    const other = await authorizedHold(payments, "hold-2");
    await payments.capture(captureOf(other.authorization.authorizationId, { idempotencyKey: paypalRequestId("capture", "item-2") }));
    expect(
      (await refusal(payments.capture(captureOf(id, { idempotencyKey: paypalRequestId("capture", "item-3") })))).code,
    ).toBe("DUPLICATE_INVOICE_ID");

    advance(29);
    const expired = await refusal(
      payments.capture(captureOf(id, { invoiceId: "FH-event-1-143", idempotencyKey: paypalRequestId("capture", "item-4") })),
    );
    expect(expired).toMatchObject({ code: "AUTHORIZATION_EXPIRED", httpStatus: 422, retryable: false });
  });

  it("simulates sandbox negative testing with mockIssue", async () => {
    const { payments } = setup();
    const { authorization } = await authorizedHold(payments);

    const declined = await refusal(payments.capture(captureOf(authorization.authorizationId, { mockIssue: "INSTRUMENT_DECLINED" })));
    expect(declined).toMatchObject({ code: "INSTRUMENT_DECLINED", httpStatus: 422, debugId: expect.stringMatching(/^sim-/) });

    const busy = await refusal(payments.capture(captureOf(authorization.authorizationId, { mockIssue: "PREVIOUS_REQUEST_IN_PROGRESS" })));
    expect(busy).toMatchObject({ httpStatus: 409, retryable: true });

    // A mocked failure leaves the authorization as it was.
    await expect(payments.getAuthorization(authorization.authorizationId)).resolves.toMatchObject({ status: "CREATED" });
  });

  it("voids once, on the original authorization", async () => {
    const { payments } = setup();
    const { authorization } = await authorizedHold(payments);
    const id = authorization.authorizationId;

    await expect(payments.void({ authorizationId: id, idempotencyKey: paypalRequestId("void", "hold-1") })).resolves.toMatchObject({
      status: "VOIDED",
    });
    // The same request id replays the success; a new one learns it is already voided.
    await expect(payments.void({ authorizationId: id, idempotencyKey: paypalRequestId("void", "hold-1") })).resolves.toMatchObject({
      status: "VOIDED",
    });
    const again = await refusal(payments.void({ authorizationId: id, idempotencyKey: paypalRequestId("void", "item-9") }));
    expect(again.code).toBe("PREVIOUSLY_VOIDED");
    expect((await refusal(payments.capture(captureOf(id)))).code).toBe("AUTHORIZATION_VOIDED");
  });

  it("reauthorizes only on the original id, after the honor period and within the US limit", async () => {
    const { payments, advance } = setup();
    const { authorization } = await authorizedHold(payments);
    const original = authorization.authorizationId;
    const reauthorize = (authorizationId: string, amountCents = 500_00, attempt = 1) =>
      payments.reauthorize({ authorizationId, amountCents, idempotencyKey: paypalRequestId("reauthorize", "hold-1", attempt) });

    expect((await refusal(reauthorize(original))).code).toBe("REAUTHORIZATION_TOO_SOON");

    advance(4);
    // 115% of $500 is $575, which is within the $75 cap.
    expect((await refusal(reauthorize(original, 576_00, 2))).code).toBe("AUTHORIZATION_AMOUNT_EXCEEDED");
    const renewed = await reauthorize(original, 575_00, 3);
    expect(renewed).toMatchObject({ status: "CREATED", amountCents: 575_00 });
    expect(renewed.authorizationId).not.toBe(original);
    expect(renewed.expiresAt).toEqual(authorization.expiresAt);

    expect((await refusal(reauthorize(renewed.authorizationId, 575_00, 4))).code).toBe("REAUTHORIZATION_NOT_SUPPORTED");
    const voidRenewed = await refusal(
      payments.void({ authorizationId: renewed.authorizationId, idempotencyKey: paypalRequestId("void", "hold-1") }),
    );
    expect(voidRenewed.code).toBe("CANNOT_BE_VOIDED");

    await payments.void({ authorizationId: original, idempotencyKey: paypalRequestId("void", "hold-1", 2) });
    await expect(payments.getAuthorization(renewed.authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("caps a reauthorization at $75 over the original for large holds", async () => {
    const { payments, advance } = setup();
    const { authorization } = await authorizedHold(payments, "hold-big", 1_000_00);
    advance(4);
    const attempt = (amountCents: number, n: number) =>
      payments.reauthorize({
        authorizationId: authorization.authorizationId,
        amountCents,
        idempotencyKey: paypalRequestId("reauthorize", "hold-big", n),
      });

    expect((await refusal(attempt(1_076_00, 1))).code).toBe("AUTHORIZATION_AMOUNT_EXCEEDED");
    await expect(attempt(1_075_00, 2)).resolves.toMatchObject({ amountCents: 1_075_00 });
  });

  it("refuses to authorize an unknown or already authorized order", async () => {
    const { payments } = setup();
    const { order } = await authorizedHold(payments);

    const twice = await refusal(payments.authorizeOrder({ orderId: order.orderId, idempotencyKey: paypalRequestId("authorize-order", "x") }));
    expect(twice.code).toBe("ORDER_ALREADY_AUTHORIZED");
    const unknown = await refusal(payments.authorizeOrder({ orderId: "NOPE", idempotencyKey: paypalRequestId("authorize-order", "y") }));
    expect(unknown).toMatchObject({ code: "INVALID_RESOURCE_ID", httpStatus: 404 });
  });

  it("applies the same request checks as the sandbox", async () => {
    const { payments } = setup();
    await expect(
      payments.createAuthorizeOrder({
        holdId: "hold-1",
        amountCents: 499_99,
        description: "Bidding power",
        softDescriptor: "RIVERSIDEGALA",
        returnUrl: "https://fairhold.example/r",
        cancelUrl: "https://fairhold.example/c",
        idempotencyKey: paypalRequestId("create-order", "hold-1"),
      }),
    ).rejects.toThrow(/whole dollars/);
  });
});
