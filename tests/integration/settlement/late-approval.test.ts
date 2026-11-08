/**
 * A PayPal window approved while settlement is starting or running. The swap holds its paddle row and
 * then the event row FOR SHARE, so settlement must never see a hold change under it, and an approval
 * that lands after bidding ended stays out of the charge and has its authorization released.
 */
import { describe, expect, it } from "vitest";

import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { processSettlementQueue, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { closeEvent, placeBid } from "@/server/engine";
import { createEvent, createLot, createPaddle } from "../engine/support/fixtures";

import { dependenciesFor, holdRow, itemOf, itemsOf, receiptOf, untilWaitingOnLocks } from "./support";

const { pool, db } = getTestDatabase();

function simulated() {
  const payments = new SimulatedPayments(createSimulatedPaypalState());
  const flow: HoldFlowDependencies = {
    store: createPostgresHoldStore(db),
    paymentsFor: () => payments,
    now: () => new Date(),
    sleep: async () => {},
  };
  return { payments, flow, deps: dependenciesFor(pool, db, payments) };
}

type Sim = ReturnType<typeof simulated>;

async function pendingHold({ payments }: Sim, eventId: string, paddleId: string, amountCents: number) {
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
  return { holdId, orderId: order.orderId };
}

/** Jamie holds $500 and leads Lot 07 at $320; bidding is still open. */
async function liveGala(sim: Sim) {
  const eventId = await createEvent(pool);
  const jamie = await createPaddle(pool, eventId, 142);
  await pool.query("update paddles set is_simulated = false where id = $1", [jamie]);
  const lot = await createLot(pool, eventId, { number: 7, startingBidCents: 32_000, minRaiseCents: 2_000 });
  const first = await pendingHold(sim, eventId, jamie, 50_000);
  expect(await completeHoldApproval(first, sim.flow)).toMatchObject({ kind: "authorized" });
  expect(await placeBid(jamie, lot, 32_000, "guest", { pool })).toMatchObject({ ok: true });
  return { eventId, jamie, lot, first };
}

describe("a late hold approval", () => {
  it("after settlement started: it is refused and released, and the charge uses the hold that was in place", async () => {
    const sim = simulated();
    const { eventId, jamie, first } = await liveGala(sim);
    const raise = await pendingHold(sim, eventId, jamie, 70_000);
    await closeEvent(eventId, { pool });

    await startSettlement({ eventId, startedBySessionId: null }, sim.deps);
    const late = await completeHoldApproval(raise, sim.flow);

    expect(late).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });
    await expect(holdRow(pool, raise.holdId)).resolves.toMatchObject({ status: "voided" });

    await processSettlementQueue(sim.deps);
    await expect(holdRow(pool, first.holdId)).resolves.toMatchObject({ status: "captured", amount_cents: 50_000, captured_cents: 32_000 });
    expect(await itemOf(pool, eventId, 142)).toMatchObject({ status: "succeeded", hold_id: first.holdId, amount_cents: 32_000, released_cents: 18_000 });
    expect((await receiptOf(pool, eventId, jamie))[0]).toMatchObject({ hold_cents: 50_000, paid_cents: 32_000, released_cents: 18_000 });
  });

  it("after the settlement finished: the same, and nothing about the charge moves", async () => {
    const sim = simulated();
    const { eventId, jamie, first } = await liveGala(sim);
    const raise = await pendingHold(sim, eventId, jamie, 70_000);
    await closeEvent(eventId, { pool });
    await startSettlement({ eventId, startedBySessionId: null }, sim.deps);
    await processSettlementQueue(sim.deps);

    expect(await completeHoldApproval(raise, sim.flow)).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });

    await expect(holdRow(pool, raise.holdId)).resolves.toMatchObject({ status: "voided" });
    await expect(holdRow(pool, first.holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
    expect(await itemsOf(pool, eventId)).toHaveLength(1);
  });

  it("a first hold that lands after bidding ended is released too, and that paddle has nothing to settle", async () => {
    const sim = simulated();
    const { eventId } = await liveGala(sim);
    const kai = await createPaddle(pool, eventId, 143);
    const pending = await pendingHold(sim, eventId, kai, 25_000);
    await closeEvent(eventId, { pool });
    await startSettlement({ eventId, startedBySessionId: null }, sim.deps);

    expect(await completeHoldApproval(pending, sim.flow)).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });

    await expect(holdRow(pool, pending.holdId)).resolves.toMatchObject({ status: "voided" });
    expect((await itemsOf(pool, eventId)).map((item) => item.paddle_number)).toEqual([142]);
  });

  it("racing the start, never deadlocks: whichever wins, one authorization is charged and the other released", async () => {
    for (let round = 0; round < 8; round += 1) {
      const sim = simulated();
      const { eventId, jamie, first } = await liveGala(sim);
      const raise = await pendingHold(sim, eventId, jamie, 70_000);
      await closeEvent(eventId, { pool });

      const [approval, started] = await Promise.all([
        completeHoldApproval(raise, sim.flow),
        startSettlement({ eventId, startedBySessionId: null }, sim.deps),
      ]);

      expect(approval).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });
      expect(started.kind).toBe("started");
      await processSettlementQueue(sim.deps);
      await expect(holdRow(pool, first.holdId)).resolves.toMatchObject({ status: "captured", captured_cents: 32_000 });
      await expect(holdRow(pool, raise.holdId)).resolves.toMatchObject({ status: "voided" });
    }
  });

  it("the settlement reads holds only after any swap holding a paddle row has committed", async () => {
    const sim = simulated();
    const { eventId, jamie, first } = await liveGala(sim);
    await closeEvent(eventId, { pool });

    // A writer in mid-transaction on the paddle row: start must wait for it, then read what it left.
    const swap = await pool.connect();
    await swap.query("begin");
    await swap.query("select id from paddles where id = $1 for no key update", [jamie]);
    await swap.query("update holds set amount_cents = 70000 where id = $1", [first.holdId]);

    const starting = startSettlement({ eventId, startedBySessionId: null }, sim.deps);
    await untilWaitingOnLocks(pool, 1);
    await swap.query("commit");
    swap.release();
    await starting;

    expect(await itemOf(pool, eventId, 142)).toMatchObject({ amount_cents: 32_000, released_cents: 38_000 });
    const { rows } = await pool.query<{ status: string }>("select status from events where id = $1", [eventId]);
    expect(rows[0]?.status).toBe("settling");
  });

  it("moves the event to settling before it reads the holds, in one transaction", async () => {
    const sim = simulated();
    const { eventId } = await liveGala(sim);
    await closeEvent(eventId, { pool });

    // Holding the event row FOR SHARE, as a swap does, keeps the status from moving and blocks the start.
    const swap = await pool.connect();
    await swap.query("begin");
    await swap.query("select status from events where id = $1 for share", [eventId]);

    const starting = startSettlement({ eventId, startedBySessionId: null }, sim.deps);
    await untilWaitingOnLocks(pool, 1);
    const during = await pool.query<{ status: string; items: number }>(
      `select e.status, (select count(*)::int from settlements s where s.event_id = e.id) as items from events e where e.id = $1`,
      [eventId],
    );
    expect(during.rows[0]).toEqual({ status: "closed", items: 0 });

    await swap.query("commit");
    swap.release();
    await starting;
    expect(await itemsOf(pool, eventId)).toHaveLength(1);
  });
});
