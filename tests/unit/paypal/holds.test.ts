import { describe, expect, it, vi } from "vitest";

import { PaypalError } from "@/server/paypal/errors";
import { cancelHoldApproval, completeHoldApproval, HONOR_PERIOD_MS, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { Payments } from "@/server/paypal/payments";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

import { MemoryHoldStore } from "./memory-hold-store";

const NOW = new Date("2026-11-04T20:00:00Z");

function setup() {
  const store = new MemoryHoldStore();
  const payments = new SimulatedPayments(createSimulatedPaypalState(), () => NOW);
  const dependencies: HoldFlowDependencies = {
    store,
    paymentsFor: () => payments,
    now: () => NOW,
    sleep: async () => {},
  };
  return { store, payments, dependencies };
}

/** A pending hold whose order the buyer has approved (simulated approval is instant). */
async function pendingHold(
  store: MemoryHoldStore,
  payments: Payments,
  id: string,
  amountCents = 500_00,
  paddleId = "paddle-142",
) {
  const order = await payments.createAuthorizeOrder({
    holdId: id,
    amountCents,
    description: "Bidding power",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `https://fairhold.example/paypal/return?hold=${id}`,
    cancelUrl: `https://fairhold.example/paypal/cancel?hold=${id}`,
    idempotencyKey: paypalRequestId("create-order", id),
  });
  return store.add({ id, paddleId, amountCents, paypalOrderId: order.orderId });
}

describe("completeHoldApproval", () => {
  it("authorizes the order and stores the id as both original and current, with the honor period", async () => {
    const { store, payments, dependencies } = setup();
    const hold = await pendingHold(store, payments, "hold-1");

    const outcome = await completeHoldApproval({ holdId: "hold-1", orderId: hold.paypalOrderId }, dependencies);

    expect(outcome).toMatchObject({ kind: "authorized", alreadyAuthorized: false });
    const stored = store.get("hold-1");
    expect(stored.status).toBe("authorized");
    expect(stored.originalAuthorizationId).toMatch(/^SIMA/);
    expect(stored.currentAuthorizationId).toBe(stored.originalAuthorizationId);
    expect(stored.authorizedAt).toEqual(NOW);
    expect(stored.honorUntil).toEqual(new Date(NOW.getTime() + HONOR_PERIOD_MS));
    expect(stored.expiresAt).toEqual(new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000));
    expect(stored.payerEmail).toMatch(/\.invalid$/);
    await expect(payments.getAuthorization(stored.originalAuthorizationId!)).resolves.toMatchObject({ status: "CREATED" });
  });

  it("is idempotent: a reloaded return page does not authorize again", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    const authorize = vi.spyOn(payments, "authorizeOrder");

    await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);
    const again = await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    expect(again).toMatchObject({ kind: "authorized", alreadyAuthorized: true });
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("uses the hold id for the authorize request id, so a backstop retry replays it", async () => {
    const { store, payments, dependencies } = setup();
    const hold = await pendingHold(store, payments, "hold-1");
    const authorize = vi.spyOn(payments, "authorizeOrder");

    await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    expect(authorize).toHaveBeenCalledWith({
      orderId: hold.paypalOrderId,
      idempotencyKey: paypalRequestId("authorize-order", "hold-1"),
    });
  });

  it("raises bidding power: the new hold replaces the old one and the old authorization is voided", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-500", 500_00);
    await completeHoldApproval({ holdId: "hold-500", orderId: null }, dependencies);
    const oldAuthorization = store.get("hold-500").originalAuthorizationId!;
    await pendingHold(store, payments, "hold-750", 750_00);
    const voidCall = vi.spyOn(payments, "void");

    const outcome = await completeHoldApproval({ holdId: "hold-750", orderId: null }, dependencies);

    expect(outcome).toMatchObject({ kind: "authorized", hold: { amountCents: 750_00 } });
    expect(store.get("hold-750").status).toBe("authorized");
    expect(store.get("hold-500")).toMatchObject({ status: "voided", replacedByHoldId: "hold-750" });
    expect(voidCall).toHaveBeenCalledWith({ authorizationId: oldAuthorization, idempotencyKey: paypalRequestId("void", "hold-500") });
    await expect(payments.getAuthorization(oldAuthorization)).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("keeps a raise when voiding the old authorization fails, leaving it replaced for the sweep", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-500", 500_00);
    await completeHoldApproval({ holdId: "hold-500", orderId: null }, dependencies);
    await pendingHold(store, payments, "hold-750", 750_00);
    const busy = new PaypalError({ operation: "void", code: "PREVIOUS_REQUEST_IN_PROGRESS", httpStatus: 409, debugId: "dbg-1" });
    const voidCall = vi.spyOn(payments, "void").mockRejectedValue(busy);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await completeHoldApproval({ holdId: "hold-750", orderId: null }, dependencies);

    expect(outcome.kind).toBe("authorized");
    expect(voidCall).toHaveBeenCalledTimes(3);
    expect(store.get("hold-500")).toMatchObject({ status: "replaced", lastError: { code: "PREVIOUS_REQUEST_IN_PROGRESS", debugId: "dbg-1" } });
    errorLog.mockRestore();
  });

  it("keeps the larger hold when an older, smaller raise window is approved later, and releases that approval", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-500", 500_00);
    await completeHoldApproval({ holdId: "hold-500", orderId: null }, dependencies);
    await pendingHold(store, payments, "hold-600", 600_00);
    await pendingHold(store, payments, "hold-750", 750_00);
    await completeHoldApproval({ holdId: "hold-750", orderId: null }, dependencies);
    store.committedCents.set("paddle-142", 700_00);
    const voidCall = vi.spyOn(payments, "void");

    const outcome = await completeHoldApproval({ holdId: "hold-600", orderId: null }, dependencies);

    expect(outcome).toMatchObject({
      kind: "refused",
      refusal: { reason: "not_a_raise", currentHoldCents: 750_00 },
      hold: { id: "hold-600", status: "voided", amountCents: 600_00 },
    });
    expect(store.get("hold-750").status).toBe("authorized");
    expect(store.get("hold-600")).toMatchObject({ status: "voided", replacedByHoldId: "hold-750" });
    const released = store.get("hold-600").originalAuthorizationId!;
    expect(voidCall).toHaveBeenCalledWith({ authorizationId: released, idempotencyKey: paypalRequestId("void", "hold-600") });
    await expect(payments.getAuthorization(released)).resolves.toMatchObject({ status: "VOIDED" });
    await expect(payments.getAuthorization(store.get("hold-750").originalAuthorizationId!)).resolves.toMatchObject({
      status: "CREATED",
    });
  });

  it("refuses a hold that would not cover what the paddle has already committed", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-600", 600_00);
    store.committedCents.set("paddle-142", 700_00);

    const outcome = await completeHoldApproval({ holdId: "hold-600", orderId: null }, dependencies);

    expect(outcome).toMatchObject({ kind: "refused", refusal: { reason: "below_commitments", committedCents: 700_00 } });
    expect(store.get("hold-600").status).toBe("voided");
  });

  it("releases an approval that arrives after bidding ended and leaves the hold settlement uses", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-500", 500_00);
    await completeHoldApproval({ holdId: "hold-500", orderId: null }, dependencies);
    await pendingHold(store, payments, "hold-750", 750_00);
    store.eventStatus = "closed";

    const outcome = await completeHoldApproval({ holdId: "hold-750", orderId: null }, dependencies);

    expect(outcome).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });
    expect(store.get("hold-500").status).toBe("authorized");
    await expect(payments.getAuthorization(store.get("hold-500").originalAuthorizationId!)).resolves.toMatchObject({
      status: "CREATED",
    });
    expect(store.get("hold-750").status).toBe("voided");
  });

  it("leaves a refused approval replaced, with its authorization stored, when the void fails", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-500", 500_00);
    await completeHoldApproval({ holdId: "hold-500", orderId: null }, dependencies);
    await pendingHold(store, payments, "hold-400", 400_00);
    vi.spyOn(payments, "void").mockRejectedValue(
      new PaypalError({ operation: "void", code: "INTERNAL_SERVER_ERROR", httpStatus: 503, debugId: "dbg-void" }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await completeHoldApproval({ holdId: "hold-400", orderId: null }, dependencies);

    expect(outcome).toMatchObject({ kind: "refused", hold: { status: "replaced" } });
    expect(store.get("hold-400")).toMatchObject({
      status: "replaced",
      replacedByHoldId: "hold-500",
      originalAuthorizationId: expect.stringMatching(/^SIMA/),
      lastError: { code: "INTERNAL_SERVER_ERROR", debugId: "dbg-void" },
    });
    expect(store.get("hold-500").status).toBe("authorized");
    errorLog.mockRestore();
  });

  it("marks a declined hold denied with PayPal's code and debug_id", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    vi.spyOn(payments, "authorizeOrder").mockRejectedValue(
      new PaypalError({ operation: "authorizeOrder", code: "INSTRUMENT_DECLINED", httpStatus: 422, debugId: "dbg-declined" }),
    );
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const outcome = await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    expect(outcome.kind).toBe("declined");
    expect(store.get("hold-1")).toMatchObject({
      status: "denied",
      lastError: { operation: "authorizeOrder", code: "INSTRUMENT_DECLINED", httpStatus: 422, debugId: "dbg-declined" },
    });
    errorLog.mockRestore();
  });

  it("leaves the hold pending when PayPal has not finished", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    vi.spyOn(payments, "authorizeOrder").mockRejectedValue(
      new PaypalError({ operation: "authorizeOrder", code: "INTERNAL_SERVER_ERROR", httpStatus: 503, debugId: "dbg-503" }),
    );

    const outcome = await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    expect(outcome.kind).toBe("pending");
    expect(store.get("hold-1")).toMatchObject({ status: "pending_approval", lastError: { debugId: "dbg-503" } });
  });

  it("voids the new authorization when the hold was canceled while PayPal authorized it", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    store.beforeMarkAuthorized = () => {
      store.get("hold-1").status = "canceled";
    };
    const voidCall = vi.spyOn(payments, "void");

    const outcome = await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    expect(outcome.kind).toBe("not_pending");
    expect(voidCall).toHaveBeenCalledTimes(1);
    const voided = voidCall.mock.calls[0]![0].authorizationId;
    await expect(payments.getAuthorization(voided)).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("refuses a return whose token is another order, and unknown holds", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    const authorize = vi.spyOn(payments, "authorizeOrder");

    await expect(completeHoldApproval({ holdId: "hold-1", orderId: "OTHERORDER" }, dependencies)).resolves.toMatchObject({
      kind: "order_mismatch",
    });
    await expect(completeHoldApproval({ holdId: "missing", orderId: null }, dependencies)).resolves.toEqual({ kind: "not_found" });
    expect(authorize).not.toHaveBeenCalled();
    expect(store.get("hold-1").status).toBe("pending_approval");
  });
});

describe("cancelHoldApproval", () => {
  it("cancels a pending hold", async () => {
    const { store, payments, dependencies } = setup();
    const hold = await pendingHold(store, payments, "hold-1");

    await expect(cancelHoldApproval({ holdId: "hold-1", orderId: hold.paypalOrderId }, dependencies)).resolves.toMatchObject({
      kind: "canceled",
    });
    expect(store.get("hold-1").status).toBe("canceled");
  });

  it("never cancels a hold that is already authorized", async () => {
    const { store, payments, dependencies } = setup();
    await pendingHold(store, payments, "hold-1");
    await completeHoldApproval({ holdId: "hold-1", orderId: null }, dependencies);

    await expect(cancelHoldApproval({ holdId: "hold-1", orderId: null }, dependencies)).resolves.toMatchObject({
      kind: "not_pending",
      hold: { status: "authorized" },
    });
    expect(store.get("hold-1").status).toBe("authorized");
  });
});
