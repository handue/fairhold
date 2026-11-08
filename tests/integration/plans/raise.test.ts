/**
 * Raise preparation (docs/planning/glim-autopilot.md §6.4) on Postgres: $800 named over a $500
 * hold. When the dinner gets away, Glim prepares a raise, which is only a stored amount. The
 * guest approves $600 through the real PayPal window flow (simulated payments), and the hold_raised
 * fact applies the prepared plan with no model call: Chef's Table back up to $480, bid $420.
 */
import { describe, expect, it } from "vitest";

import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";
import { goldenProposal, modelReply, scriptedModel, toolUseBlock } from "../../unit/glim/helpers";

import { bid, createGala, forbiddenModel, makeDue, recordedModel, rows, startBidding } from "./support";

const database = getTestDatabase();
const { pool, db } = database;

const payments = new SimulatedPayments(createSimulatedPaypalState());
const dependencies: HoldFlowDependencies = {
  store: createPostgresHoldStore(db),
  paymentsFor: () => payments,
  now: () => new Date(),
  sleep: async () => {},
};

/** The guest approves `amountCents` in the PayPal window: a pending hold, its order, the return page. */
async function approveHold(eventId: string, paddleId: string, amountCents: number) {
  const { rows: inserted } = await pool.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', $3) returning id",
    [eventId, paddleId, amountCents],
  );
  const holdId = inserted[0]?.id;
  if (!holdId) throw new Error("no hold id");
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
  return completeHoldApproval({ holdId, orderId: order.orderId }, dependencies);
}

async function runDue(paddleId: string, model = recordedModel) {
  await scanFacts(pool);
  await makeDue(pool, paddleId);
  const [claim] = await claimDue(pool, { limit: 4 });
  if (!claim) throw new Error("nothing was due");
  return { claim, report: await runAutopilot(claim, { database, model }) };
}

describe("a raise Glim prepares", () => {
  it("is stored for the guest to approve, then applied as planned once the new hold lands", async () => {
    const gala = await createGala(pool);
    // "$800. I really want the chef's dinner. Spa only under $120." The $800 is over the $500
    // hold, so the first proposal goes back once and the card plans within $500.
    let call = 0;
    const chat = scriptedModel(() => modelReply([toolUseBlock("propose_plan", goldenProposal(call++ === 0 ? 800 : 500))]));
    const { card, confirmed } = await startBidding(database, gala.jamie, {
      guestText: "$800. I really want the chef's dinner. Spa only under $120.",
      model: chat.model,
    });
    expect(card).toMatchObject({ budgetCents: 50_000, namedBudgetCents: 80_000, backups: [] });
    expect(confirmed.mandate?.budgetCents).toBe(80_000);

    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    const prepared = await runDue(gala.jamie);
    expect(prepared.report).toMatchObject({ outcome: "raise_prepared", decidedBy: "model" });
    expect(prepared.report.decision?.fixtureKey).toBe("autopilot:limit_exhausted:7:7");

    const [action] = await rows<{ kind: string; amount_cents: number; lot_id: string; detail: { pendingIntent: unknown[]; raise: { minCents: number; maxCents: number } } }>(
      pool,
      "select kind, amount_cents, lot_id, detail from glim_actions where id = $1",
      [prepared.report.actionId],
    );
    expect(action?.kind).toBe("autopilot_raise_prepared");
    expect(action?.lot_id).toBe(gala.lots.chef);
    expect(action?.amount_cents).toBeGreaterThanOrEqual(54_000);
    expect(action?.amount_cents).toBeLessThanOrEqual(80_000);
    expect(action?.detail.raise).toMatchObject({ minCents: 54_000, maxCents: 80_000 });
    const [message] = await rows<{ card: Record<string, unknown> }>(pool, "select card from chat_messages where id = $1", [
      prepared.report.chatMessageId,
    ]);
    expect(message?.card).toMatchObject({
      type: "autopilot_raise",
      amountCents: action?.amount_cents,
      currentHoldCents: 50_000,
      budgetCents: 80_000,
      dismissLabel: "Not now",
    });
    // Nothing moved: no limit, no hold, no plan version.
    expect(await rows(pool, "select 1 from bid_limits where paddle_id = $1 and lot_id = $2 and active", [gala.jamie, gala.lots.chef])).toEqual([]);
    expect(await rows(pool, "select amount_cents from holds where paddle_id = $1 and status = 'authorized'", [gala.jamie])).toEqual([
      { amount_cents: 50_000 },
    ]);
    expect(await rows(pool, "select version from glim_plans where id = $1", [confirmed.planId])).toEqual([{ version: 1 }]);

    // The guest approves $600 in PayPal.
    expect((await approveHold(gala.eventId, gala.jamie, 60_000)).kind).toBe("authorized");

    const model = forbiddenModel();
    const applied = await runDue(gala.jamie, model);
    expect(applied.claim.reasons.map((reason) => reason.kind)).toEqual(["hold_raised"]);
    expect(applied.report).toMatchObject({ outcome: "applied", decidedBy: "pending_raise" });
    expect(model.calls).toBe(0);
    expect(
      await rows(pool, "select lot_id, max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents", [gala.jamie]),
    ).toEqual([
      { lot_id: gala.lots.spa, max_cents: 12_000 },
      { lot_id: gala.lots.chef, max_cents: 48_000 },
    ]);
    expect(await rows(pool, "select current_bid_cents, high_paddle_id from lots where id = $1", [gala.lots.chef])).toEqual([
      { current_bid_cents: 42_000, high_paddle_id: gala.jamie },
    ]);
    const [card2] = await rows<{ card: Record<string, unknown> }>(pool, "select card from chat_messages where id = $1", [applied.report.chatMessageId]);
    expect(card2?.card).toMatchObject({
      triggerLine: "Your $600 is held with PayPal.",
      whatLine: "I’m back on Chef’s Table. I bid $420 for you and will go up to $480.",
      whyLine: "You approved the raise for this lot.",
      whySource: "template",
    });
  });

  it("is never prepared twice while one is pending", async () => {
    const gala = await createGala(pool);
    let call = 0;
    const chat = scriptedModel(() => modelReply([toolUseBlock("propose_plan", goldenProposal(call++ === 0 ? 800 : 500))]));
    await startBidding(database, gala.jamie, { guestText: "$800. Chef's dinner first. Spa only under $120.", model: chat.model });
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    expect((await runDue(gala.jamie)).report.outcome).toBe("raise_prepared");
    // The rival outbids Spa Day too: with a raise pending, no new raise is an option.
    await bid(pool, gala.rival, gala.lots.spa, 12_500);
    const again = await runDue(gala.jamie);
    expect(again.report.outcome).not.toBe("raise_prepared");
    expect(await rows(pool, "select count(*)::int as count from glim_actions where paddle_id = $1 and kind = 'autopilot_raise_prepared'", [gala.jamie])).toEqual([
      { count: 1 },
    ]);
  });
});
