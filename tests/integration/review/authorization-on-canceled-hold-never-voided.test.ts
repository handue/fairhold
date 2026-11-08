/**
 * Review finding (wave 2): an authorization that lands on a hold no longer pending can be lost.
 * The hold row never stores its id, so nothing can retry the void. day1.md's rule is that the sweep
 * retries every void still owed; these two paths are outside it. The guest's money stays held at
 * PayPal for up to 29 days. Until the fix, these fail.
 */
import { describe, expect, it } from "vitest";

import { runSweep } from "@/server/director/sweep";
import { PaypalError } from "@/server/paypal/errors";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { AuthorizeOrderRequest, Payments } from "@/server/paypal/payments";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import { processWebhookEvents } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";
import { dependenciesFor } from "../settlement/support";

const { pool, db } = getTestDatabase();
const store = createPostgresHoldStore(db);

async function pendingOrder(payments: SimulatedPayments) {
  const eventId = await createEvent(pool);
  const paddleId = await createPaddle(pool, eventId, 142);
  await pool.query("update paddles set is_simulated = false where id = $1", [paddleId]);
  const { rows } = await pool.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', 50000) returning id",
    [eventId, paddleId],
  );
  const holdId = rows[0]?.id ?? "";
  const order = await payments.createAuthorizeOrder({
    holdId,
    amountCents: 50_000,
    description: "Bidding power",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `https://fairhold.example/paypal/return?hold=${holdId}`,
    cancelUrl: `https://fairhold.example/paypal/cancel?hold=${holdId}`,
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  await pool.query("update holds set paypal_order_id = $2 where id = $1", [holdId, order.orderId]);
  return { holdId, orderId: order.orderId };
}

describe("an authorization on a hold that is no longer pending", () => {
  it("a cancel during authorize, then a failed void: the sweep can still void it", async () => {
    const payments = new SimulatedPayments(createSimulatedPaypalState());
    const { holdId, orderId } = await pendingOrder(payments);
    let authorizationId = "";

    const racing = Object.create(payments, {
      authorizeOrder: {
        value: async (request: AuthorizeOrderRequest) => {
          const answer = await payments.authorizeOrder(request);
          authorizationId = answer.authorization.authorizationId;
          // The cancel page, or CHECKOUT.PAYMENT-APPROVAL.REVERSED, gets in while PayPal answers.
          await store.markCanceled(holdId);
          return answer;
        },
      },
      void: {
        value: async () => {
          throw new PaypalError({ operation: "void", code: "INTERNAL_SERVER_ERROR", httpStatus: 500, debugId: "debug-500" });
        },
      },
    }) as Payments;
    const flow: HoldFlowDependencies = { store, paymentsFor: () => racing, now: () => new Date(), sleep: async () => {} };

    expect(await completeHoldApproval({ holdId, orderId }, flow)).toMatchObject({ kind: "not_pending" });
    expect((await payments.getAuthorization(authorizationId)).status).toBe("CREATED");

    // PayPal is back: the sweep is the only thing left that could release it.
    await runSweep({ pool, paymentsFor: () => payments });

    expect((await payments.getAuthorization(authorizationId)).status).toBe("VOIDED");
  });

  it("PAYMENT.AUTHORIZATION.CREATED for a canceled hold voids what PayPal holds", async () => {
    const payments = new SimulatedPayments(createSimulatedPaypalState());
    const { holdId, orderId } = await pendingOrder(payments);
    // The authorize went through but its answer was lost, and then the guest canceled.
    const { authorization } = await payments.authorizeOrder({
      orderId,
      idempotencyKey: paypalRequestId("authorize-order", holdId),
    });
    await store.markCanceled(holdId);

    await createPostgresWebhookEventStore(db).insertOnce({
      eventId: `WH-CANCELED-${holdId}`,
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceType: "authorization",
      resourceId: authorization.authorizationId,
      payload: {
        id: `WH-CANCELED-${holdId}`,
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: authorization.authorizationId,
          status: "CREATED",
          custom_id: holdId,
          amount: { currency_code: "USD", value: "500.00" },
        },
      },
    });
    const flow: HoldFlowDependencies = { store, paymentsFor: () => payments, now: () => new Date(), sleep: async () => {} };
    await processWebhookEvents({}, { ...dependenciesFor(pool, db, payments), holds: store, holdFlow: flow });

    expect((await payments.getAuthorization(authorization.authorizationId)).status).toBe("VOIDED");
  });
});
