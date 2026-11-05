/**
 * Adversarial review (Day 1): the PayPal return page swaps a paddle's authorized hold without
 * checking it against what the paddle has already committed. The engine keeps commitments within
 * the hold it reads, but markAuthorized can replace that hold with a smaller one afterwards, so
 * the invariant (commitments <= active hold) breaks outside the engine.
 *
 * Realistic path: two "Raise bidding power" windows (one from 07, one from 10). Each asks for
 * more than the hold at the moment it opened, so even a createHold that refuses a lower total
 * passes them. The guest approves the larger one, bids up to it, then approves the older,
 * smaller window: that hold becomes the bidding power and the larger authorization is voided.
 */
import { describe, expect, it } from "vitest";

import { getBiddingPower, placeBid } from "@/server/engine";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createLot, createPaddle } from "../engine/support/fixtures";

const { pool, db } = getTestDatabase();

const payments = new SimulatedPayments(createSimulatedPaypalState());
const dependencies: HoldFlowDependencies = {
  store: createPostgresHoldStore(db),
  paymentsFor: () => payments,
  now: () => new Date(),
  sleep: async () => {},
};

/** What opening the PayPal window does first: a pending hold and its AUTHORIZE order. */
async function pendingHold(eventId: string, paddleId: string, amountCents: number) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', $3) returning id",
    [eventId, paddleId, amountCents],
  );
  const holdId = rows[0]?.id;
  if (!holdId) throw new Error("insert returned no hold id");
  const order = await payments.createAuthorizeOrder({
    holdId,
    amountCents,
    description: "Bidding power for Riverside Shelter Gala",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `http://localhost:3000/paypal/return?hold=${holdId}`,
    cancelUrl: `http://localhost:3000/paypal/cancel?hold=${holdId}`,
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  await pool.query("update holds set paypal_order_id = $2 where id = $1", [holdId, order.orderId]);
  return { holdId, orderId: order.orderId };
}

describe("review: a hold swap keeps commitments within the hold", () => {
  it("does not make a smaller approved hold the bidding power while more is committed", async () => {
    const eventId = await createEvent(pool);
    const jamie = await createPaddle(pool, eventId, 142);
    const chefsTable = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
    const cabin = await createLot(pool, eventId, { number: 3, startingBidCents: 41_000, minRaiseCents: 2_000 });

    // $500 of bidding power, then two raise windows opened while it stood: $600 (from 10) and $750 (from 07).
    const first = await pendingHold(eventId, jamie, 50_000);
    expect(await completeHoldApproval(first, dependencies)).toMatchObject({ kind: "authorized" });
    const raiseTo600 = await pendingHold(eventId, jamie, 60_000);
    const raiseTo750 = await pendingHold(eventId, jamie, 75_000);

    // The guest approves the $750 window and bids $700 within it.
    expect(await completeHoldApproval(raiseTo750, dependencies)).toMatchObject({ kind: "authorized" });
    expect(await placeBid(jamie, chefsTable, 29_000, "guest", { pool })).toMatchObject({ ok: true });
    expect(await placeBid(jamie, cabin, 41_000, "guest", { pool })).toMatchObject({ ok: true });
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({ holdCents: 75_000, committedCents: 70_000 });

    // Then the forgotten $600 window is approved too.
    await completeHoldApproval(raiseTo600, dependencies);

    const power = (await getBiddingPower([jamie], pool)).get(jamie);
    // Failed before the Day 1 fix: the $600 hold replaced the $750 one (which was voided) with $700 committed.
    expect(power?.committedCents).toBeLessThanOrEqual(power?.holdCents ?? 0);
  });
});
