/**
 * The seam between the PayPal window and the engine: the hold the return page authorizes is the
 * bidding power placeBid enforces, a raise swaps it without a moment of two authorized holds, a
 * cancel leaves none, an approval that may not replace the hold in place is released, and every
 * change reaches the paddle's live channel through the same event_log helper the engine writes
 * with.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { getBiddingPower, placeBid } from "@/server/engine";
import { createPostgresHoldStore, type HoldStatus } from "@/server/paypal/hold-store";
import { cancelHoldApproval, completeHoldApproval, type HoldFlowDependencies } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";

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

async function holdStatuses(paddleId: string): Promise<{ id: string; status: HoldStatus; amount: number }[]> {
  const { rows } = await pool.query<{ id: string; status: HoldStatus; amount: number }>(
    "select id, status, amount_cents as amount from holds where paddle_id = $1 order by created_at, id",
    [paddleId],
  );
  return rows;
}

async function holdEvents(paddleId: string): Promise<unknown[]> {
  const { rows } = await pool.query<{ payload: unknown }>(
    "select payload from event_log where paddle_id = $1 and type = 'hold' order by id",
    [paddleId],
  );
  return rows.map((row) => row.payload);
}

/** Waits until this many backends of the test database are blocked on a lock. */
async function untilWaitingOnLocks(count: number): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await sleep(10);
  }
  throw new Error(`fewer than ${count} backends started waiting on a lock`);
}

async function gala() {
  const eventId = await createEvent(pool);
  const jamie = await createPaddle(pool, eventId, 142);
  const chefsTable = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
  const cabin = await createLot(pool, eventId, { number: 3, startingBidCents: 41_000, minRaiseCents: 2_000 });
  return { eventId, jamie, chefsTable, cabin };
}

describe("PayPal hold to engine", () => {
  it("makes the approved hold the bidding power placeBid enforces", async () => {
    const { eventId, jamie, chefsTable, cabin } = await gala();
    expect(await placeBid(jamie, chefsTable, 10_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "no_hold" },
    });

    const { holdId, orderId } = await pendingHold(eventId, jamie, 50_000);
    expect(await completeHoldApproval({ holdId, orderId }, dependencies)).toMatchObject({ kind: "authorized" });

    expect(await placeBid(jamie, chefsTable, 10_000, "guest", { pool })).toMatchObject({ ok: true, leading: true });
    expect(await placeBid(jamie, cabin, 41_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", holdCents: 50_000, availableCents: 40_000, shortfallCents: 1_000 },
    });
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({
      holdId,
      holdCents: 50_000,
      committedCents: 10_000,
      leftCents: 40_000,
    });
    expect(await holdEvents(jamie)).toEqual([{ holdId, status: "authorized", amountCents: 50_000 }]);
  });

  it("raises by authorizing the new total and voiding the old hold, with one authorized hold throughout", async () => {
    const { eventId, jamie, chefsTable, cabin } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    await placeBid(jamie, chefsTable, 10_000, "guest", { pool });

    const raise = await pendingHold(eventId, jamie, 70_000);
    expect(await completeHoldApproval(raise, dependencies)).toMatchObject({ kind: "authorized" });

    expect(await holdStatuses(jamie)).toEqual([
      { id: first.holdId, status: "voided", amount: 50_000 },
      { id: raise.holdId, status: "authorized", amount: 70_000 },
    ]);
    const { rows } = await pool.query<{ original: string }>(
      "select original_authorization_id as original from holds where id = $1",
      [first.holdId],
    );
    await expect(payments.getAuthorization(rows[0]?.original ?? "")).resolves.toMatchObject({ status: "VOIDED" });

    expect(await placeBid(jamie, cabin, 41_000, "guest", { pool })).toMatchObject({ ok: true });
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({
      holdId: raise.holdId,
      holdCents: 70_000,
      committedCents: 51_000,
    });
    expect(await holdEvents(jamie)).toEqual([
      { holdId: first.holdId, status: "authorized", amountCents: 50_000 },
      { holdId: raise.holdId, status: "authorized", amountCents: 70_000 },
      { holdId: first.holdId, status: "replaced", replacedByHoldId: raise.holdId },
      { holdId: first.holdId, status: "voided" },
    ]);
  });

  it("leaves no bidding power after a canceled window", async () => {
    const { eventId, jamie, chefsTable } = await gala();
    const pending = await pendingHold(eventId, jamie, 25_000);

    expect(await cancelHoldApproval(pending, dependencies)).toMatchObject({ kind: "canceled" });
    expect(await completeHoldApproval(pending, dependencies)).toMatchObject({ kind: "not_pending" });

    expect(await holdStatuses(jamie)).toEqual([{ id: pending.holdId, status: "canceled", amount: 25_000 }]);
    expect(await placeBid(jamie, chefsTable, 10_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "no_hold" },
    });
    expect(await holdEvents(jamie)).toEqual([{ holdId: pending.holdId, status: "canceled" }]);
  });
});

describe("an approval that may not replace the hold in place", () => {
  it("is released when it arrives after bidding closed, and the hold settlement uses stays", async () => {
    const { eventId, jamie } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    const late = await pendingHold(eventId, jamie, 75_000);
    await pool.query("update events set status = 'closed' where id = $1", [eventId]);

    expect(await completeHoldApproval(late, dependencies)).toMatchObject({
      kind: "refused",
      refusal: { reason: "bidding_ended" },
      hold: { status: "voided" },
    });

    expect(await holdStatuses(jamie)).toEqual([
      { id: first.holdId, status: "authorized", amount: 50_000 },
      { id: late.holdId, status: "voided", amount: 75_000 },
    ]);
    const { rows } = await pool.query<{ original: string; replaced_by: string | null }>(
      "select original_authorization_id as original, replaced_by_hold_id as replaced_by from holds where id = $1",
      [late.holdId],
    );
    expect(rows[0]?.replaced_by).toBe(first.holdId);
    await expect(payments.getAuthorization(rows[0]?.original ?? "")).resolves.toMatchObject({ status: "VOIDED" });
    expect((await holdEvents(jamie)).slice(1)).toEqual([
      {
        holdId: late.holdId,
        status: "replaced",
        amountCents: 75_000,
        replacedByHoldId: first.holdId,
        reason: "bidding_ended",
      },
      { holdId: late.holdId, status: "voided" },
    ]);
  });

  it("is refused when it would not cover the paddle's bids, by the engine's own commitments", async () => {
    const { eventId, jamie, chefsTable } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    expect(await placeBid(jamie, chefsTable, 30_000, "guest", { pool })).toMatchObject({ ok: true });
    // The hold ran out (PayPal's 29 days) while the paddle still leads; a new one must cover that bid.
    await pool.query("update holds set status = 'expired' where id = $1", [first.holdId]);

    expect(await completeHoldApproval(await pendingHold(eventId, jamie, 20_000), dependencies)).toMatchObject({
      kind: "refused",
      refusal: { reason: "below_commitments", committedCents: 30_000 },
    });
    const enough = await pendingHold(eventId, jamie, 40_000);
    expect(await completeHoldApproval(enough, dependencies)).toMatchObject({ kind: "authorized" });
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({
      holdId: enough.holdId,
      holdCents: 40_000,
      committedCents: 30_000,
    });
  });
});

describe("a raise and a bid in flight together", () => {
  it("decides the bid against the new hold once the swap commits", async () => {
    const { eventId, jamie } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    const cabin = await createLot(pool, eventId, { number: 4, startingBidCents: 60_000, minRaiseCents: 2_000 });
    const raise = await pendingHold(eventId, jamie, 75_000);

    // Holding the event row stops the approval at its event check, after it locked the paddle.
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from events where id = $1 for no key update", [eventId]);
      const approval = completeHoldApproval(raise, dependencies);
      await untilWaitingOnLocks(1);
      const bid = placeBid(jamie, cabin, 60_000, "guest", { pool });
      await untilWaitingOnLocks(2);
      await blocker.query("commit");

      expect(await approval).toMatchObject({ kind: "authorized" });
      expect(await bid).toMatchObject({ ok: true, leading: true });
    } finally {
      blocker.release();
    }
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({
      holdId: raise.holdId,
      holdCents: 75_000,
      committedCents: 60_000,
    });
  });

  it("makes a bid wait on the paddle row, so a swap that holds it is never read halfway", async () => {
    const { eventId, jamie } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    const cabin = await createLot(pool, eventId, { number: 4, startingBidCents: 60_000, minRaiseCents: 2_000 });

    // A swap in markAuthorized's order: the paddle row first, the holds after the bid is waiting.
    const swap = await pool.connect();
    try {
      await swap.query("begin");
      await swap.query("select id from paddles where id = $1 for no key update", [jamie]);
      const bid = placeBid(jamie, cabin, 60_000, "guest", { pool });
      await untilWaitingOnLocks(1);
      await swap.query("update holds set status = 'replaced' where id = $1", [first.holdId]);
      await createHold(swap, eventId, jamie, 75_000);
      await swap.query("commit");

      expect(await bid).toMatchObject({ ok: true, leading: true });
    } finally {
      swap.release();
    }
  });

  it("still finds the bidder's new hold when a swap skipped the paddle row", async () => {
    const { eventId, jamie } = await gala();
    const first = await pendingHold(eventId, jamie, 50_000);
    await completeHoldApproval(first, dependencies);
    const cabin = await createLot(pool, eventId, { number: 4, startingBidCents: 60_000, minRaiseCents: 2_000 });

    // The bid waits on the old hold row; once the swap commits that row is replaced, and the new
    // one was not there when the bid's read began.
    const swap = await pool.connect();
    try {
      await swap.query("begin");
      await swap.query("update holds set status = 'replaced' where id = $1", [first.holdId]);
      await createHold(swap, eventId, jamie, 75_000);
      const bid = placeBid(jamie, cabin, 60_000, "guest", { pool });
      await untilWaitingOnLocks(1);
      await swap.query("commit");

      expect(await bid).toMatchObject({ ok: true, leading: true });
    } finally {
      swap.release();
    }
  });
});
