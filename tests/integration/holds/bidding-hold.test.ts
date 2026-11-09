/**
 * Which hold is a guest's bidding power, for the pages that say what is held (11, Glim's closing
 * card, 14's bidder count and the demo guide). A PayPal approval refused as bidding power keeps
 * PayPal's authorization on its row until the void, so it is often the newest row with authorized_at:
 * it must never be read as the guest's hold, before the charge or after it (review 2, finding 1).
 */
import { describe, expect, it } from "vitest";

import { closeEvent, placeBid } from "@/server/engine";
import { readBiddingHold } from "@/server/holds/bidding-hold";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { readProjectorExtras } from "@/server/queries/projector";
import { getReceiptView } from "@/server/queries/receipt-view";
import { processSettlementQueue, startSettlement } from "@/server/settlement";
import { readGuideProgress } from "@/ui/demo/demo-state";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createLot, createPaddle } from "../engine/support/fixtures";
import { dependenciesFor, holdRow } from "../settlement/support";

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

/** A PayPal window opened for `amountCents`, waiting for the guest's approval. */
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

/** Jamie (paddle 142) holds $500 with PayPal and leads Lot 07 at $320; bidding is still open. */
async function liveGala(sim: Sim) {
  const eventId = await createEvent(pool);
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
  const slug = rows[0]?.slug ?? "";
  const jamie = await createPaddle(pool, eventId, 142);
  await pool.query("update paddles set is_simulated = false where id = $1", [jamie]);
  const lot = await createLot(pool, eventId, { number: 7, startingBidCents: 32_000, minRaiseCents: 2_000 });
  const first = await pendingHold(sim, eventId, jamie, 50_000);
  expect(await completeHoldApproval(first, sim.flow)).toMatchObject({ kind: "authorized" });
  expect(await placeBid(jamie, lot, 32_000, "guest", { pool })).toMatchObject({ ok: true });
  return { eventId, slug, jamie, lot, first };
}

describe("the hold that is a guest's bidding power", () => {
  it("after the charge, 11 shows the charged hold and its authorization, never the refused approval's", async () => {
    const sim = simulated();
    const { eventId, slug, jamie, first } = await liveGala(sim);
    const late = await pendingHold(sim, eventId, jamie, 80_000);
    await closeEvent(eventId, { pool });
    expect(await completeHoldApproval(late, sim.flow)).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });

    expect(await readBiddingHold(pool, jamie)).toMatchObject({ id: first.holdId, amountCents: 50_000, status: "authorized", settled: false });

    await startSettlement({ eventId, startedBySessionId: null }, sim.deps);
    await processSettlementQueue(sim.deps);

    const charged = await holdRow(pool, first.holdId);
    expect(await readBiddingHold(pool, jamie)).toMatchObject({ id: first.holdId, status: "captured", settled: true });
    const receipt = await getReceiptView({ slug, paddleNumber: 142 }, pool);
    expect(receipt).toMatchObject({
      phase: "paid",
      payCents: 32_000,
      releaseCents: 18_000,
      hold: { cents: 50_000, authorizationId: charged.original_authorization_id },
    });
    const refused = await holdRow(pool, late.holdId);
    expect(receipt?.hold?.authorizationId).not.toBe(refused.original_authorization_id);
  });

  it("a guest whose only approval came after the close never held: 11, 14 and the guide all say so", async () => {
    const sim = simulated();
    const { eventId, slug } = await liveGala(sim);
    const kai = await createPaddle(pool, eventId, 143);
    await pool.query("update paddles set is_simulated = false where id = $1", [kai]);
    const late = await pendingHold(sim, eventId, kai, 25_000);
    await closeEvent(eventId, { pool });
    expect(await completeHoldApproval(late, sim.flow)).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });
    await expect(holdRow(pool, late.holdId)).resolves.toMatchObject({ status: "voided" });

    expect(await readBiddingHold(pool, kai)).toBeNull();
    expect(await getReceiptView({ slug, paddleNumber: 143 }, pool)).toMatchObject({ phase: "released", hold: null, releaseCents: 0 });
    expect((await readProjectorExtras(pool, eventId)).bidderIds).not.toContain(kai);
    expect(await readGuideProgress({ paddleId: kai, status: "closed" }, pool)).toMatchObject({ power: false });
  });

  it("an approval PayPal authorized after its window was canceled is not a hold either", async () => {
    const sim = simulated();
    const { eventId } = await liveGala(sim);
    const kai = await createPaddle(pool, eventId, 143);
    const canceled = await pendingHold(sim, eventId, kai, 25_000);
    expect(await createPostgresHoldStore(db).markCanceled(canceled.holdId)).toBe(true);
    expect(await completeHoldApproval(canceled, sim.flow)).toMatchObject({ kind: "not_pending" });
    await pool.query("update holds set status = 'voided' where id = $1 and status = 'replaced'", [canceled.holdId]);

    expect(await readBiddingHold(pool, kai)).toBeNull();
    expect((await readProjectorExtras(pool, eventId)).bidderIds).not.toContain(kai);
    expect(await readGuideProgress({ paddleId: kai, status: "live" }, pool)).toMatchObject({ power: false });
  });

  it("after a raise it is the raised hold, and a hold PayPal voided later still counts as the one that was held", async () => {
    const sim = simulated();
    const { eventId, slug, jamie, first } = await liveGala(sim);
    const raise = await pendingHold(sim, eventId, jamie, 70_000);
    expect(await completeHoldApproval(raise, sim.flow)).toMatchObject({ kind: "authorized" });
    await expect(holdRow(pool, first.holdId)).resolves.toMatchObject({ status: "voided" });
    expect(await readBiddingHold(pool, jamie)).toMatchObject({ id: raise.holdId, amountCents: 70_000, status: "authorized" });

    // PayPal reports the raised authorization voided (the webhook's path for a hold under a live
    // paddle): nothing is held now, but it was the guest's bidding power, never the $500 it replaced.
    await pool.query("update holds set status = 'voided' where id = $1", [raise.holdId]);
    await pool.query("update lots set winning_paddle_id = null, current_bid_cents = null, high_paddle_id = null where event_id = $1", [eventId]);
    await pool.query("delete from bids where paddle_id = $1", [jamie]);
    await closeEvent(eventId, { pool });
    expect(await readBiddingHold(pool, jamie)).toMatchObject({ id: raise.holdId, amountCents: 70_000, status: "voided", settled: false });
    expect(await getReceiptView({ slug, paddleNumber: 142 }, pool)).toMatchObject({ phase: "released", hold: { cents: 70_000 } });
    expect((await readProjectorExtras(pool, eventId)).bidderIds).toContain(jamie);
  });
});
