/**
 * Review finding (wave 2): holds.ts says of a PENDING authorization "the authorization webhook
 * completes it", but it does not. The webhook calls authorizeOrder again, the same request id replays
 * PENDING, and the event is marked processed. The hold stays pending_approval with no authorization
 * id: no bidding power for the guest, and no void for the money PayPal holds. Until the fix, this fails.
 */
import { describe, expect, it, vi } from "vitest";

import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import { processWebhookEvents } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";
import { dependenciesFor, holdRow } from "../settlement/support";

const { pool, db } = getTestDatabase();

describe("an authorization PayPal holds for review", () => {
  it("becomes bidding power when PAYMENT.AUTHORIZATION.CREATED says it is CREATED", async () => {
    const payments = new SimulatedPayments(createSimulatedPaypalState());
    const store = createPostgresHoldStore(db);
    const flow: HoldFlowDependencies = { store, paymentsFor: () => payments, now: () => new Date(), sleep: async () => {} };

    const eventId = await createEvent(pool);
    const paddleId = await createPaddle(pool, eventId, 142);
    const { rows } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents, paypal_order_id) values ($1, $2, 'paypal', 50000, 'REVIEWORDER') returning id",
      [eventId, paddleId],
    );
    const holdId = rows[0]?.id ?? "";

    // PayPal replays the same answer for the same request id, as orders do for 6 hours.
    const authorizeOrder = vi.spyOn(payments, "authorizeOrder").mockResolvedValue({
      orderId: "REVIEWORDER",
      authorization: {
        authorizationId: "REVIEWAUTH",
        status: "PENDING",
        amountCents: 50_000,
        createdAt: new Date(),
        expiresAt: undefined,
        customId: holdId,
      },
      payer: { payerId: undefined, email: undefined, givenName: undefined, surname: undefined },
      debugId: undefined,
      raw: {},
    });

    expect(await completeHoldApproval({ holdId, orderId: "REVIEWORDER" }, flow)).toMatchObject({ kind: "pending" });
    expect(authorizeOrder.mock.calls[0]?.[0].idempotencyKey).toBe(paypalRequestId("authorize-order", holdId));

    await createPostgresWebhookEventStore(db).insertOnce({
      eventId: "WH-REVIEW-DONE",
      eventType: "PAYMENT.AUTHORIZATION.CREATED",
      resourceType: "authorization",
      resourceId: "REVIEWAUTH",
      payload: {
        id: "WH-REVIEW-DONE",
        event_type: "PAYMENT.AUTHORIZATION.CREATED",
        resource: {
          id: "REVIEWAUTH",
          status: "CREATED",
          custom_id: holdId,
          amount: { currency_code: "USD", value: "500.00" },
          create_time: "2026-11-08T04:00:00Z",
          expiration_time: "2026-12-07T04:00:00Z",
        },
      },
    });
    await processWebhookEvents({}, { ...dependenciesFor(pool, db, payments), holds: store, holdFlow: flow });

    await expect(holdRow(pool, holdId)).resolves.toMatchObject({
      status: "authorized",
      original_authorization_id: "REVIEWAUTH",
    });
  });
});
