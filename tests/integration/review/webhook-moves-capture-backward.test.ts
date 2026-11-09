/**
 * Review finding (wave 2): webhook.ts promises "a state machine that moves forward and never back",
 * but neither capture event compares its capture id with the row's. PayPal does not promise delivery
 * order, so a late event about an old capture can undo a row's state. Until the fix, these fail.
 */
import { describe, expect, it } from "vitest";

import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import { processSettlementQueue, processWebhookEvents, retrySettlementItem, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { json } from "../../unit/paypal/fake-paypal";
import { dependenciesFor, itemOf, paypalWorld, runGala } from "../settlement/support";

const { pool, db } = getTestDatabase();
const store = createPostgresWebhookEventStore(db);
let nextEvent = 1;

async function deliver(eventType: string, captureId: string, authorizationId: string, status: string) {
  const eventId = `WH-BACK-${nextEvent}`;
  nextEvent += 1;
  await store.insertOnce({
    eventId,
    eventType,
    resourceType: "capture",
    resourceId: captureId,
    payload: {
      id: eventId,
      event_type: eventType,
      resource: {
        id: captureId,
        status,
        amount: { currency_code: "USD", value: "320.00" },
        links: [{ rel: "up", href: `https://api-m.sandbox.paypal.com/v2/payments/authorizations/${authorizationId}` }],
      },
    },
  });
}

async function chargingWithPendingCapture() {
  const world = paypalWorld();
  const deps = dependenciesFor(pool, db, world.payments);
  const webhook = { ...deps, holds: createPostgresHoldStore(db) };
  const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
  await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
  const authorizationId = gala.holds.get(142)?.authorizationId ?? "";
  const oldCapture = `OLD${authorizationId}`;
  world.failNext("capture", authorizationId, () =>
    json(201, { id: oldCapture, status: "PENDING", amount: { currency_code: "USD", value: "320.00" } }),
  );
  await processSettlementQueue(deps);
  expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending", paypal_capture_id: oldCapture });
  return { world, deps, webhook, gala, authorizationId, oldCapture };
}

describe("capture events arriving out of order", () => {
  it("a PENDING that arrives after its DECLINED leaves the row failed, with its reason", async () => {
    const { webhook, gala, authorizationId, oldCapture } = await chargingWithPendingCapture();

    await deliver("PAYMENT.CAPTURE.DECLINED", oldCapture, authorizationId, "DECLINED");
    await processWebhookEvents({}, webhook);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed", error_code: "CAPTURE_DECLINED" });

    await deliver("PAYMENT.CAPTURE.PENDING", oldCapture, authorizationId, "PENDING");
    await processWebhookEvents({}, webhook);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed", error_code: "CAPTURE_DECLINED" });
  });

  it("a late PENDING for the declined capture does not take a retried row off the queue", async () => {
    const { deps, webhook, gala, authorizationId, oldCapture } = await chargingWithPendingCapture();

    await deliver("PAYMENT.CAPTURE.DECLINED", oldCapture, authorizationId, "DECLINED");
    await processWebhookEvents({}, webhook);
    const failed = await itemOf(pool, gala.eventId, 142);
    await retrySettlementItem(gala.eventId, failed.id, deps);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "queued" });

    await deliver("PAYMENT.CAPTURE.PENDING", oldCapture, authorizationId, "PENDING");
    await processWebhookEvents({}, webhook);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "queued" });
  });

  it("a late DECLINED for the old capture does not fail the new capture PayPal is still working on", async () => {
    const { world, deps, webhook, gala, authorizationId, oldCapture } = await chargingWithPendingCapture();

    await deliver("PAYMENT.CAPTURE.DECLINED", oldCapture, authorizationId, "DECLINED");
    await processWebhookEvents({}, webhook);
    const failed = await itemOf(pool, gala.eventId, 142);
    const newCapture = `NEW${authorizationId}`;
    world.failNext("capture", authorizationId, () =>
      json(201, { id: newCapture, status: "PENDING", amount: { currency_code: "USD", value: "320.00" } }),
    );
    await retrySettlementItem(gala.eventId, failed.id, deps);
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending", paypal_capture_id: newCapture });

    // PayPal delivers the old capture's decline a second time, under a new event id.
    await deliver("PAYMENT.CAPTURE.DECLINED", oldCapture, authorizationId, "DECLINED");
    await processWebhookEvents({}, webhook);

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "pending", paypal_capture_id: newCapture });
  });
});
