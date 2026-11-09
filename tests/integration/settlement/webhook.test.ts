/**
 * Webhook processing on Postgres: every event applied from paypal_webhook_events, moving forward
 * only, whatever order PayPal delivers in and however many times.
 */
import { describe, expect, it, vi } from "vitest";

import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import type { HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import type { WebhookEvent } from "@/server/paypal/webhooks";
import { processSettlementQueue, processWebhookEvents, retrySettlementItem, startSettlement, voidReplacedHolds } from "@/server/settlement";
import type { WebhookDependencies } from "@/server/settlement/webhook";

import { getTestDatabase } from "../../helpers/database";
import { json, paypalError } from "../../unit/paypal/fake-paypal";
import { createEvent, createPaddle } from "../engine/support/fixtures";

import {
  dependenciesFor,
  eventRow,
  expireLeases,
  holdRow,
  insertRealHold,
  itemOf,
  paypalWorld,
  receiptOf,
  runGala,
  type PaypalWorld,
} from "./support";

const { pool, db } = getTestDatabase();

const store = createPostgresWebhookEventStore(db);
let nextEvent = 1;

async function deliver(eventType: string, resource: Record<string, unknown>): Promise<string> {
  const eventId = `WH-${nextEvent}`;
  nextEvent += 1;
  const event: WebhookEvent = {
    eventId,
    eventType,
    resourceType: null,
    resourceId: typeof resource.id === "string" ? resource.id : null,
    payload: { id: eventId, event_type: eventType, resource },
  };
  await store.insertOnce(event);
  return eventId;
}

async function processed(eventId: string) {
  const { rows } = await pool.query<{ processed_at: Date | null; error: string | null }>(
    "select processed_at, error from paypal_webhook_events where paypal_event_id = $1",
    [eventId],
  );
  return rows[0];
}

/** A capture as PayPal's webhooks carry it, with an id of its own unless the test names one. */
function captureResource(authorizationId: string, overrides: Record<string, unknown> = {}) {
  const id = `W${authorizationId}`;
  return {
    id,
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "320.00" },
    final_capture: true,
    invoice_id: "unused",
    create_time: "2026-11-08T05:31:00Z",
    links: [
      { rel: "self", href: `https://api-m.sandbox.paypal.com/v2/payments/captures/${id}` },
      { rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${authorizationId}` },
    ],
    ...overrides,
  };
}

function setup() {
  const world = paypalWorld();
  const deps = dependenciesFor(pool, db, world.payments);
  const webhook: Partial<WebhookDependencies> = { ...deps, holds: createPostgresHoldStore(db) };
  return { world, deps, webhook };
}

async function charging(world: PaypalWorld, webhook: Partial<WebhookDependencies>) {
  const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
  await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, webhook);
  const authorizationId = gala.holds.get(142)?.authorizationId ?? "";
  const holdId = gala.holds.get(142)?.holdId ?? "";
  return { gala, authorizationId, holdId, paddleId: gala.paddles.get(142) ?? "" };
}

describe("PAYMENT.CAPTURE.COMPLETED", () => {
  it("changes nothing on a charge the API already recorded, however many times it arrives", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId, paddleId } = await charging(world, webhook);
    await processSettlementQueue(deps);
    const before = await itemOf(pool, gala.eventId, 142);

    const id = world.captures[0]?.captureId;
    const first = await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(authorizationId, { id }));
    const second = await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(authorizationId, { id }));
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 2, failed: 0 });

    expect(await itemOf(pool, gala.eventId, 142)).toEqual(before);
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect(await receiptOf(pool, gala.eventId, paddleId)).toHaveLength(1);
    expect((await processed(first))?.processed_at).toBeInstanceOf(Date);
    expect((await processed(second))?.processed_at).toBeInstanceOf(Date);
    // Already applied, so a later run finds nothing to do.
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 0, failed: 0 });
  });

  it("brings a failed row forward when the money did move: capture id, hold, receipt, and the settlement finishes", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId, paddleId } = await charging(world, webhook);
    world.failNext("capture", authorizationId, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));
    for (let tries = 0; tries < 5; tries += 1) {
      world.failNext("capture", authorizationId, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));
      await processSettlementQueue(deps);
      await expireLeases(pool, gala.eventId);
    }
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "done_with_errors" });
    const authorization = world.authorizations.get(authorizationId);
    if (authorization) authorization.status = "CAPTURED";

    const afterRequeue = vi.fn();
    await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(authorizationId));
    await processWebhookEvents({}, { ...webhook, afterRequeue });
    expect(afterRequeue).toHaveBeenCalledOnce();

    const captureId = `W${authorizationId}`;
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "queued", paypal_capture_id: captureId, error_code: null });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect((await receiptOf(pool, gala.eventId, paddleId))[0]).toMatchObject({ paypal_capture_id: captureId, paid_cents: 32_000 });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ settlement_status: "running" });

    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded", paypal_capture_id: captureId });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });

  it("finds its item by the hold id it carries, or the invoice id, when there is no up link", async () => {
    const { world, webhook } = setup();
    const byHold = await charging(world, webhook);
    await deliver("PAYMENT.CAPTURE.COMPLETED", { id: "BYHOLD", status: "COMPLETED", amount: { currency_code: "USD", value: "320.00" }, custom_id: byHold.holdId });
    const byInvoice = await charging(world, webhook);
    await deliver("PAYMENT.CAPTURE.COMPLETED", {
      id: "BYINVOICE",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "320.00" },
      invoice_id: `FH-${byInvoice.gala.eventId}-142`,
    });
    await processWebhookEvents({}, webhook);
    expect((await receiptOf(pool, byHold.gala.eventId, byHold.paddleId))[0]?.paypal_capture_id).toBe("BYHOLD");
    expect((await receiptOf(pool, byInvoice.gala.eventId, byInvoice.paddleId))[0]?.paypal_capture_id).toBe("BYINVOICE");
  });

  it("ignores a capture this app never asked for", async () => {
    const { webhook } = setup();
    const eventId = await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource("SOMEONEELSE"));
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 1, failed: 0 });
    expect((await processed(eventId))?.processed_at).toBeInstanceOf(Date);
  });
});

describe("PAYMENT.CAPTURE.PENDING and DECLINED", () => {
  it("a PENDING answer waits for the webhook: no receipt until COMPLETED", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId, paddleId } = await charging(world, webhook);
    const waitId = `WAIT${authorizationId}`;
    world.failNext("capture", authorizationId, () =>
      json(201, { id: waitId, status: "PENDING", amount: { currency_code: "USD", value: "320.00" } }),
    );

    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending", paypal_capture_id: waitId });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "authorized" });
    expect(await receiptOf(pool, gala.eventId, paddleId)).toHaveLength(0);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "done_with_errors" });
    // Neither a queue run nor the same news again moves it.
    await processSettlementQueue(deps);
    await deliver("PAYMENT.CAPTURE.PENDING", captureResource(authorizationId, { id: waitId, status: "PENDING" }));
    await processWebhookEvents({}, webhook);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending" });

    const authorization = world.authorizations.get(authorizationId);
    if (authorization) authorization.status = "CAPTURED";
    await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(authorizationId, { id: waitId }));
    await processWebhookEvents({}, webhook);
    await processSettlementQueue(deps);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded", paypal_capture_id: waitId });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect(await receiptOf(pool, gala.eventId, paddleId)).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });

  it("a declined capture that was waiting fails the row, and the retry is a new request", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId } = await charging(world, webhook);
    const waitId = `WAIT${authorizationId}`;
    world.failNext("capture", authorizationId, () =>
      json(201, { id: waitId, status: "PENDING", amount: { currency_code: "USD", value: "320.00" } }),
    );
    await processSettlementQueue(deps);
    const waiting = await itemOf(pool, gala.eventId, 142);

    await deliver("PAYMENT.CAPTURE.DECLINED", captureResource(authorizationId, { id: waitId, status: "DECLINED" }));
    await processWebhookEvents({}, webhook);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed", error_code: "CAPTURE_DECLINED", paypal_request_id: paypalRequestId("capture", waiting.id, 2) });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "authorized" });

    await retrySettlementItem(gala.eventId, waiting.id, deps);
    await processSettlementQueue(deps);
    expect(world.posts("capture", authorizationId).at(-1)?.headers["paypal-request-id"]).toBe(paypalRequestId("capture", waiting.id, 2));
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded" });
  });

  it("leaves an item no capture is waiting on to the answer its worker gets", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId } = await charging(world, webhook);
    await deliver("PAYMENT.CAPTURE.DECLINED", captureResource(authorizationId, { status: "DECLINED" }));
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 1, failed: 0 });
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "queued", error_code: null });

    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded" });
  });

  it("tells a row still waiting for its answer which capture it is on, and a decline of that capture then counts", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId } = await charging(world, webhook);
    const id = `LOST${authorizationId}`;

    await deliver("PAYMENT.CAPTURE.PENDING", captureResource(authorizationId, { id, status: "PENDING" }));
    await processWebhookEvents({}, webhook);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending", paypal_capture_id: id });
    await processSettlementQueue(deps);
    expect(world.captures).toHaveLength(0);

    await deliver("PAYMENT.CAPTURE.DECLINED", captureResource(authorizationId, { id, status: "DECLINED" }));
    await processWebhookEvents({}, webhook);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed", error_code: "CAPTURE_DECLINED", paypal_capture_id: id });
  });

  it("does not take a decline of some other capture for the one the row waits on", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId } = await charging(world, webhook);
    const waitId = `WAIT${authorizationId}`;
    world.failNext("capture", authorizationId, () =>
      json(201, { id: waitId, status: "PENDING", amount: { currency_code: "USD", value: "320.00" } }),
    );
    await processSettlementQueue(deps);
    const before = await itemOf(pool, gala.eventId, 142);

    await deliver("PAYMENT.CAPTURE.DECLINED", captureResource(authorizationId, { id: "SOMEOTHER", status: "DECLINED" }));
    await processWebhookEvents({}, webhook);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({
      status: "pending",
      paypal_capture_id: waitId,
      paypal_request_id: before.paypal_request_id,
    });
  });

  it("only moves forward: a decline or a pending after a recorded charge changes nothing and is logged", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId, paddleId } = await charging(world, webhook);
    await processSettlementQueue(deps);
    const id = world.captures[0]?.captureId;

    await deliver("PAYMENT.CAPTURE.PENDING", captureResource(authorizationId, { id, status: "PENDING" }));
    await deliver("PAYMENT.CAPTURE.DECLINED", captureResource(authorizationId, { id, status: "DECLINED" }));
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 2, failed: 0 });

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded", paypal_capture_id: id, error_code: null });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured" });
    expect(await receiptOf(pool, gala.eventId, paddleId)).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
    const { rows } = await pool.query<{ code: string }>("select code from error_log where event_id = $1 and source = 'webhook'", [gala.eventId]);
    expect(rows).toEqual([{ code: "CAPTURE_DECLINED_AFTER_COMPLETED" }]);
  });

  it("arriving before the API answer: the worker's own store then changes nothing", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId, paddleId } = await charging(world, webhook);
    // The webhook lands while the worker is waiting on PayPal's answer to the capture.
    const realCapture = world.payments.capture.bind(world.payments);
    let raced = false;
    const racing = {
      ...deps,
      paymentsFor: () =>
        new Proxy(world.payments, {
          get(target, property, receiver) {
            if (property !== "capture") {
              const value: unknown = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return async (request: Parameters<typeof realCapture>[0]) => {
              const answer = await realCapture(request);
              if (!raced) {
                raced = true;
                await deliver("PAYMENT.CAPTURE.COMPLETED", captureResource(authorizationId, { id: answer.captureId }));
                await processWebhookEvents({}, webhook);
              }
              return answer;
            };
          },
        }),
    };

    await processSettlementQueue(racing);

    expect(raced).toBe(true);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded", paypal_capture_id: world.captures[0]?.captureId });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect(await receiptOf(pool, gala.eventId, paddleId)).toHaveLength(1);
  });
});

describe("PAYMENT.AUTHORIZATION.VOIDED", () => {
  it("finishes a queued void and leaves a captured hold captured", async () => {
    const { world, deps, webhook } = setup();
    const gala = await runGala(pool, world, {
      real: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 25_000 },
      ],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    const kai = gala.holds.get(143);

    await deliver("PAYMENT.AUTHORIZATION.VOIDED", { id: kai?.authorizationId, status: "VOIDED", custom_id: kai?.holdId });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, kai?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });
    expect(await itemOf(pool, gala.eventId, 143)).toMatchObject({ status: "succeeded" });

    await processSettlementQueue(deps);
    expect(world.posts("void", kai?.authorizationId ?? "")).toHaveLength(0);

    const jamie = gala.holds.get(142);
    await deliver("PAYMENT.AUTHORIZATION.VOIDED", { id: jamie?.authorizationId, status: "VOIDED", custom_id: jamie?.holdId });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, jamie?.holdId ?? "")).resolves.toMatchObject({ status: "captured" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("confirms a replaced hold's void", async () => {
    const { world, webhook } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 70_000 }] });
    const old = await insertRealHold(pool, gala.eventId, gala.paddles.get(142) ?? "", { amountCents: 50_000, status: "replaced" });
    await deliver("PAYMENT.AUTHORIZATION.VOIDED", { id: old.authorizationId, status: "VOIDED" });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, old.holdId)).resolves.toMatchObject({ status: "voided" });
  });

  it("takes a live hold away when PayPal voided it, as at 30 days, and the charge then fails with the reason", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId } = await charging(world, webhook);
    await deliver("PAYMENT.AUTHORIZATION.VOIDED", { id: authorizationId, status: "VOIDED" });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "voided" });

    await processSettlementQueue(deps);
    expect(world.posts("capture", authorizationId)).toHaveLength(0);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed", error_code: "HOLD_VOIDED" });
    const { rows } = await pool.query<{ payload: { status: string } }>(
      "select payload from event_log where event_id = $1 and type = 'hold' order by id desc limit 1",
      [gala.eventId],
    );
    expect(rows[0]?.payload.status).toBe("voided");
  });
});

describe("the backstop for a PayPal window whose return page never ran", () => {
  function holdFlow() {
    const payments = new SimulatedPayments(createSimulatedPaypalState());
    const holds = createPostgresHoldStore(db);
    const flow: HoldFlowDependencies = { store: holds, paymentsFor: () => payments, now: () => new Date(), sleep: async () => {} };
    return { payments, holds, flow, deps: { ...dependenciesFor(pool, db, payments), holds, holdFlow: flow } satisfies Partial<WebhookDependencies> };
  }

  async function pendingOrder({ payments }: ReturnType<typeof holdFlow>, amountCents = 50_000) {
    const eventId = await createEvent(pool);
    const paddleId = await createPaddle(pool, eventId, 142);
    const { rows } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', $3) returning id",
      [eventId, paddleId, amountCents],
    );
    const holdId = rows[0]?.id ?? "";
    const order = await payments.createAuthorizeOrder({
      holdId,
      amountCents,
      description: "Bidding power",
      softDescriptor: "RIVERSIDEGALA",
      returnUrl: `http://localhost:3000/paypal/return?hold=${holdId}`,
      cancelUrl: `http://localhost:3000/paypal/cancel?hold=${holdId}`,
      idempotencyKey: paypalRequestId("create-order", holdId),
    });
    await pool.query("update holds set paypal_order_id = $2 where id = $1", [holdId, order.orderId]);
    return { eventId, paddleId, holdId, orderId: order.orderId };
  }

  it("CHECKOUT.ORDER.APPROVED authorizes with the return page's idempotency key, by custom_id or by order id", async () => {
    const sim = holdFlow();
    const byCustomId = await pendingOrder(sim);
    await deliver("CHECKOUT.ORDER.APPROVED", { id: byCustomId.orderId, status: "APPROVED", purchase_units: [{ custom_id: byCustomId.holdId }] });
    const byOrder = await pendingOrder(sim);
    await deliver("CHECKOUT.ORDER.APPROVED", { id: byOrder.orderId, status: "APPROVED" });

    expect(await processWebhookEvents({}, sim.deps)).toEqual({ applied: 2, failed: 0 });

    await expect(holdRow(pool, byCustomId.holdId)).resolves.toMatchObject({ status: "authorized", amount_cents: 50_000 });
    await expect(holdRow(pool, byOrder.holdId)).resolves.toMatchObject({ status: "authorized" });
  });

  it("does nothing when the return page got there first", async () => {
    const sim = holdFlow();
    const { holdId, orderId } = await pendingOrder(sim);
    await sim.flow.store.findHold(holdId);
    await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId, status: "APPROVED", purchase_units: [{ custom_id: holdId }] });
    await processWebhookEvents({}, sim.deps);
    const stored = await holdRow(pool, holdId);
    await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId, status: "APPROVED", purchase_units: [{ custom_id: holdId }] });
    await processWebhookEvents({}, sim.deps);
    expect(await holdRow(pool, holdId)).toEqual(stored);
  });

  it("stays unprocessed when PayPal hiccups, and the retry pass applies it", async () => {
    const sim = holdFlow();
    const { holdId, orderId } = await pendingOrder(sim);
    const eventId = await deliver("CHECKOUT.ORDER.APPROVED", { id: orderId, status: "APPROVED", purchase_units: [{ custom_id: holdId }] });
    const authorize = vi.spyOn(sim.payments, "authorizeOrder").mockRejectedValueOnce(
      new (await import("@/server/paypal/errors")).PaypalError({ operation: "authorizeOrder", code: "INTERNAL_SERVER_ERROR", httpStatus: 500 }),
    );

    expect(await processWebhookEvents({}, sim.deps)).toEqual({ applied: 0, failed: 1 });
    expect(await processed(eventId)).toMatchObject({ processed_at: null });
    expect((await processed(eventId))?.error).toContain("INTERNAL_SERVER_ERROR");
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "pending_approval" });

    // A plain run leaves a failed row alone; the once-a-minute pass asks again.
    expect(await processWebhookEvents({}, sim.deps)).toEqual({ applied: 0, failed: 0 });
    expect(await processWebhookEvents({ retryFailed: true }, sim.deps)).toEqual({ applied: 1, failed: 0 });
    expect(authorize).toHaveBeenCalledTimes(2);
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "authorized" });
    expect(await processed(eventId)).toMatchObject({ error: null });
  });

  it("PAYMENT.AUTHORIZATION.CREATED stores the authorization when authorizing again says it already was", async () => {
    const sim = holdFlow();
    const { holdId } = await pendingOrder(sim);
    const authorization = {
      id: "LOSTAUTH",
      status: "CREATED",
      custom_id: holdId,
      amount: { currency_code: "USD", value: "500.00" },
      create_time: "2026-11-08T04:00:00Z",
      expiration_time: "2026-12-07T04:00:00Z",
    };
    vi.spyOn(sim.payments, "authorizeOrder").mockRejectedValue(
      new (await import("@/server/paypal/errors")).PaypalError({ operation: "authorizeOrder", code: "ORDER_ALREADY_AUTHORIZED", httpStatus: 422 }),
    );
    await deliver("PAYMENT.AUTHORIZATION.CREATED", authorization);
    await processWebhookEvents({}, sim.deps);
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({
      status: "authorized",
      amount_cents: 50_000,
      original_authorization_id: "LOSTAUTH",
      current_authorization_id: "LOSTAUTH",
    });
  });

  it("PAYMENT.AUTHORIZATION.CREATED after bidding ended stores it as refused and releases it", async () => {
    const world = paypalWorld();
    const holds = createPostgresHoldStore(db);
    const flow: HoldFlowDependencies = { store: holds, paymentsFor: () => world.payments, now: () => new Date(), sleep: async () => {} };
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }] });
    const { rows } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents, paypal_order_id) values ($1, $2, 'paypal', 70000, 'LOSTORDER') returning id",
      [gala.eventId, gala.paddles.get(142)],
    );
    const holdId = rows[0]?.id ?? "";
    world.paypal.on("POST", "/v2/checkout/orders/LOSTORDER/authorize", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED", "debug-already"),
    );
    world.authorize("LOSTAUTH2", 70_000);

    await deliver("PAYMENT.AUTHORIZATION.CREATED", {
      id: "LOSTAUTH2",
      status: "CREATED",
      custom_id: holdId,
      amount: { currency_code: "USD", value: "700.00" },
    });
    await processWebhookEvents({}, { ...dependenciesFor(pool, db, world.payments), holds, holdFlow: flow });

    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "voided", original_authorization_id: "LOSTAUTH2" });
    expect(world.voids.map((item) => item.authorizationId)).toEqual(["LOSTAUTH2"]);
    await expect(holdRow(pool, gala.holds.get(142)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized", amount_cents: 50_000 });
  });

  it("PAYMENT.AUTHORIZATION.CREATED while it is still under review leaves the hold waiting", async () => {
    const sim = holdFlow();
    const { holdId } = await pendingOrder(sim);
    vi.spyOn(sim.payments, "authorizeOrder").mockResolvedValue({
      orderId: "REVIEWORDER",
      authorization: { authorizationId: "REVIEWAUTH", status: "PENDING", amountCents: 50_000, createdAt: new Date(), expiresAt: undefined, customId: holdId },
      payer: { payerId: undefined, email: undefined, givenName: undefined, surname: undefined },
      debugId: undefined,
      raw: {},
    });

    await deliver("PAYMENT.AUTHORIZATION.CREATED", { id: "REVIEWAUTH", status: "PENDING", custom_id: holdId, amount: { value: "500.00" } });
    expect(await processWebhookEvents({}, sim.deps)).toEqual({ applied: 1, failed: 0 });

    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "pending_approval", original_authorization_id: null });
  });

  it("PAYMENT.AUTHORIZATION.CREATED prefers authorizing again, which also brings the payer", async () => {
    const sim = holdFlow();
    const { holdId, paddleId } = await pendingOrder(sim);

    await deliver("PAYMENT.AUTHORIZATION.CREATED", { id: "IGNORED", status: "CREATED", custom_id: holdId, amount: { value: "500.00" } });
    await processWebhookEvents({}, sim.deps);

    const row = await holdRow(pool, holdId);
    expect(row).toMatchObject({ status: "authorized" });
    expect(row.original_authorization_id).toMatch(/^SIMA/);
    const { rows } = await pool.query<{ email: string | null }>("select email from paddles where id = $1", [paddleId]);
    expect(rows[0]?.email).toMatch(/\.invalid$/);
  });

  it.each(["denied", "failed"])("PAYMENT.AUTHORIZATION.CREATED for a hold that ended %s voids what PayPal holds", async (status) => {
    const sim = holdFlow();
    const { holdId, orderId } = await pendingOrder(sim);
    const { authorization } = await sim.payments.authorizeOrder({ orderId, idempotencyKey: paypalRequestId("authorize-order", holdId) });
    await pool.query("update holds set status = $2 where id = $1", [holdId, status]);

    await deliver("PAYMENT.AUTHORIZATION.CREATED", { id: authorization.authorizationId, status: "CREATED", custom_id: holdId, amount: { value: "500.00" } });
    await processWebhookEvents({}, sim.deps);

    await expect(sim.payments.getAuthorization(authorization.authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "voided", original_authorization_id: authorization.authorizationId });
  });

  it("PAYMENT.AUTHORIZATION.CREATED with a void that fails keeps the authorization, then the next pass releases it", async () => {
    const sim = holdFlow();
    const { holdId, orderId } = await pendingOrder(sim);
    const { authorization } = await sim.payments.authorizeOrder({ orderId, idempotencyKey: paypalRequestId("authorize-order", holdId) });
    await pool.query("update holds set status = 'canceled' where id = $1", [holdId]);
    const outage = vi.spyOn(sim.payments, "void").mockRejectedValueOnce(
      new (await import("@/server/paypal/errors")).PaypalError({ operation: "void", code: "INTERNAL_SERVER_ERROR", httpStatus: 500 }),
    );

    await deliver("PAYMENT.AUTHORIZATION.CREATED", { id: authorization.authorizationId, status: "CREATED", custom_id: holdId, amount: { value: "500.00" } });
    expect(await processWebhookEvents({}, sim.deps)).toEqual({ applied: 1, failed: 0 });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "replaced", original_authorization_id: authorization.authorizationId });
    expect(outage).toHaveBeenCalledTimes(1);

    await expect(voidReplacedHolds({}, sim.deps)).resolves.toMatchObject({ failed: 0 });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "voided" });
    await expect(sim.payments.getAuthorization(authorization.authorizationId)).resolves.toMatchObject({ status: "VOIDED" });
  });

  it("PAYMENT.AUTHORIZATION.CREATED for a reauthorization of a hold in place changes nothing", async () => {
    const { world, webhook } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }] });
    const hold = gala.holds.get(142);
    await deliver("PAYMENT.AUTHORIZATION.CREATED", { id: "RENEWED9", status: "CREATED", custom_id: hold?.holdId, amount: { value: "500.00" } });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, hold?.holdId ?? "")).resolves.toMatchObject({ status: "authorized", current_authorization_id: hold?.authorizationId });
  });

  it("CHECKOUT.PAYMENT-APPROVAL.REVERSED cancels a hold still waiting, and nothing else", async () => {
    const sim = holdFlow();
    const waiting = await pendingOrder(sim);
    await deliver("CHECKOUT.PAYMENT-APPROVAL.REVERSED", { order_id: waiting.orderId, purchase_units: [{ custom_id: waiting.holdId }] });
    await processWebhookEvents({}, sim.deps);
    await expect(holdRow(pool, waiting.holdId)).resolves.toMatchObject({ status: "canceled" });

    const { world, webhook } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }] });
    const hold = gala.holds.get(142);
    await deliver("CHECKOUT.PAYMENT-APPROVAL.REVERSED", { purchase_units: [{ custom_id: hold?.holdId }] });
    await processWebhookEvents({}, webhook);
    await expect(holdRow(pool, hold?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });
  });
});

describe("events that only get logged, or that this app does not know", () => {
  it("logs a refund or a reversal and changes nothing", async () => {
    const { world, deps, webhook } = setup();
    const { gala, authorizationId, holdId } = await charging(world, webhook);
    await processSettlementQueue(deps);
    const id = world.captures[0]?.captureId;
    await deliver("PAYMENT.CAPTURE.REFUNDED", captureResource(authorizationId, { id, status: "REFUNDED" }));
    await deliver("PAYMENT.CAPTURE.REVERSED", captureResource(authorizationId, { id, status: "REVERSED" }));
    expect(await processWebhookEvents({}, webhook)).toEqual({ applied: 2, failed: 0 });
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "succeeded" });
    const { rows } = await pool.query<{ code: string }>(
      "select code from error_log where source = 'webhook' and code in ('PAYMENT.CAPTURE.REFUNDED', 'PAYMENT.CAPTURE.REVERSED') order by id desc limit 2",
    );
    expect(rows.map((row) => row.code).sort()).toEqual(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"]);
  });

  it("marks anything else processed, and survives a resource it cannot read", async () => {
    const { webhook } = setup();
    const other = await deliver("BILLING.SUBSCRIPTION.CREATED", { id: "X" });
    const unreadable = await deliver("PAYMENT.CAPTURE.COMPLETED", { nothing: true });
    await processWebhookEvents({}, webhook);
    expect((await processed(other))?.processed_at).toBeInstanceOf(Date);
    expect((await processed(unreadable))?.processed_at).toBeInstanceOf(Date);
  });

  it("only applies verified rows, and only the one asked for", async () => {
    const { webhook } = setup();
    await pool.query(
      `insert into paypal_webhook_events (paypal_event_id, event_type, verified, payload) values ('UNVERIFIED', 'BILLING.X', false, '{}'::jsonb)`,
    );
    await processWebhookEvents({}, webhook);
    expect((await processed("UNVERIFIED"))?.processed_at).toBeNull();

    const one = await deliver("BILLING.ONE", { id: "1" });
    const two = await deliver("BILLING.TWO", { id: "2" });
    await processWebhookEvents({ paypalEventId: one }, webhook);
    expect((await processed(one))?.processed_at).toBeInstanceOf(Date);
    expect((await processed(two))?.processed_at).toBeNull();

    // The tick leaves fresh rows to the route that just stored them.
    await processWebhookEvents({ olderThanSeconds: 3_600 }, webhook);
    expect((await processed(two))?.processed_at).toBeNull();
  });
});
