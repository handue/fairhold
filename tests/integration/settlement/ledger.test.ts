/** The figures of 12 on the seeded fixture, a whole settlement of it, and the receipts it leaves. */
import { describe, expect, it } from "vitest";

import type { Queryable } from "@/server/db/transaction";
import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { closeEvent } from "@/server/engine";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import type { Payments } from "@/server/paypal/payments";
import { getLedgerView, processSettlementQueue, startSettlement } from "@/server/settlement";
import type { SettlementDependencies } from "@/server/settlement/dependencies";
import { writeReceipt, type ReceiptGlimRecap, type ReceiptLine, type ReceiptWonLine } from "@/server/settlement/receipt";

import { getTestDatabase } from "../../helpers/database";

import { dependenciesFor, eventRow, paypalWorld, receiptOf, runGala } from "./support";

const { pool, db } = getTestDatabase();

// The fixture is all simulated holds: if anything reaches PayPal, this says so.
const noPaypal: SettlementDependencies = {
  pool,
  paymentsFor: () => {
    throw new Error("A simulated guest reached the payments interface");
  },
  now: () => new Date(),
  holdStore: createPostgresHoldStore(db),
};

async function ledger(slug = FIXTURE_SLUG) {
  const view = await getLedgerView(slug, pool);
  if (!view) throw new Error(`No ledger for ${slug}`);
  return view;
}

describe("12 as approved, on the seeded fixture at 9:30 PM", () => {
  it("adds up to every figure on the screen", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const view = await ledger();

    expect(view.phase).toBe("ready");
    expect(view.event).toMatchObject({
      name: "Riverside Shelter Gala",
      charityName: "Riverside Animal Shelter",
      dateLabel: "Saturday, November 7, 2026",
      status: "closed",
      isDemo: false,
    });
    expect(view.counts).toEqual({ all: 86, winners: 19, nonWinners: 67 });
    expect(view.totals).toEqual({ heldCents: 4_395_000, toChargeCents: 816_000, toReleaseCents: 3_579_000 });
    expect(view.lots).toEqual({ total: 24, closed: 24, sold: 23, withoutBids: [{ number: 22, title: "Golf Lesson with a Pro" }] });
    expect(view.glim).toEqual({ bidders: 31, winners: 9, bids: 96 });
    expect(view.holds).toEqual({ real: 0, simulated: 86 });
    expect(view.settlement).toBeNull();
    expect(view.checks).toMatchObject({ passed: true, ranAt: null });
    expect(view.checks.checks.map((check) => [check.key, check.passed, check.count])).toEqual([
      ["winners_within_holds", true, 19],
      ["glim_within_limits", true, 96],
      ["holds_valid", true, 0],
    ]);
  });

  it("has the approved first page, in the approved order", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const view = await ledger();
    const row = (index: number) => {
      const found = view.rows[index];
      return [found?.paddleNumber, found?.bidder, found?.lotsWon, found?.glim, found?.heldCents, found?.toChargeCents, found?.toReleaseCents];
    };
    expect(row(0)).toEqual([175, "Rosa M.", "Name the Next Shelter Puppy", false, 200_000, 145_000, 55_000]);
    expect(row(1)).toEqual([168, "Owen P.", "Hot Air Balloon Ride for Two", false, 100_000, 78_000, 22_000]);
    expect(row(2)).toEqual([104, "Elena R.", "Weekend Cabin Stay", false, 100_000, 72_000, 28_000]);
    expect(row(3)).toEqual([133, "Marcus L.", "Private Wine Tasting for Six, Wine Club", true, 100_000, 70_000, 30_000]);
    expect(row(4)).toEqual([121, "Ben C.", "Riverside Theater Season Tickets", true, 75_000, 60_000, 15_000]);
    expect(row(5)).toEqual([138, "Aisha K.", "Sailing Afternoon on the Bay", true, 100_000, 52_000, 48_000]);
    expect(row(6)).toEqual([142, "Jamie K.", "Chef’s Table, Spa Day", true, 50_000, 47_000, 3_000]);
    expect(row(7)).toEqual([156, "Nora F.", "Bakery Box, Coffee Roaster Tour", true, 50_000, 42_000, 8_000]);
    expect(row(8)).toEqual([117, "Priya N.", "Dog Walking, Custom Pet Portrait", false, 50_000, 35_500, 14_500]);
    expect(row(9)).toEqual([147, "Leo W.", "Behind-the-Scenes Shelter Day", true, 50_000, 34_000, 16_000]);
    expect(view.rows[3]?.lotsWonFull).toBe("Private Wine Tasting for Six, Wine Club, Six Months");
  });

  it("settles all 86 in the database with no PayPal call, and leaves 19 receipts", async () => {
    const { event, jamie } = await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    await startSettlement({ eventId: event.id, startedBySessionId: null }, noPaypal);

    const charging = await ledger();
    expect(charging.phase).toBe("charging");
    expect(charging.settlement).toMatchObject({ status: "running", winners: 19, winnersSettled: 0, chargedCents: 0, active: 86 });

    expect(await processSettlementQueue(noPaypal)).toMatchObject({ processed: 86, finished: 1 });

    const charged = await ledger();
    expect(charged.phase).toBe("charged");
    expect(charged.event.status).toBe("settled");
    expect(charged.settlement).toMatchObject({
      status: "done",
      winners: 19,
      winnersSettled: 19,
      chargedCents: 816_000,
      releasedCents: 3_579_000,
      failed: 0,
      pending: 0,
      active: 0,
    });
    // A row's figures stay as they were charged, and it says how it settled.
    expect(charged.rows.find((row) => row.paddleNumber === 142)).toMatchObject({
      heldCents: 50_000,
      toChargeCents: 47_000,
      toReleaseCents: 3_000,
      holdKind: "simulated",
      item: { action: "simulate", status: "succeeded", paypalCaptureId: null },
    });
    expect(charged.checks.passed).toBe(true);
    expect(charged.totals).toEqual({ heldCents: 4_395_000, toChargeCents: 816_000, toReleaseCents: 3_579_000 });

    const { rows } = await pool.query<{ receipts: number; captured: number; voided: number; authorized: number }>(
      `select
         (select count(*)::int from receipts where event_id = $1) as receipts,
         (select count(*)::int from holds where event_id = $1 and status = 'captured') as captured,
         (select count(*)::int from holds where event_id = $1 and status = 'voided') as voided,
         (select count(*)::int from holds where event_id = $1 and status = 'authorized') as authorized`,
      [event.id],
    );
    expect(rows[0]).toEqual({ receipts: 19, captured: 19, voided: 67, authorized: 0 });
    expect(await eventRow(pool, event.id)).toMatchObject({ status: "settled", settlement_status: "done" });

    // 11 as approved, for paddle 142.
    const [receipt] = await receiptOf(pool, event.id, jamie.paddleId);
    expect(receipt).toMatchObject({
      number: "1107-142",
      hold_cents: 50_000,
      paid_cents: 47_000,
      released_cents: 3_000,
      deductible_cents: 2_000,
      paypal_capture_id: null,
      statement_descriptor: "RIVERSIDEGALA",
    });
    const lines = (receipt?.lines ?? []) as ReceiptLine[];
    expect(lines.filter((line) => line.kind === "won")).toMatchObject([
      { lotNumber: 7, title: "Chef’s Table Dinner for Four", paidCents: 38_000, estimatedValueCents: 48_000, deductibleCents: 0, bidBy: "glim", limitCents: 38_000 },
      { lotNumber: 12, title: "Spa Day for Two", paidCents: 9_000, estimatedValueCents: 7_000, deductibleCents: 2_000, bidBy: "glim", limitCents: 12_000 },
    ]);
    expect(lines.filter((line) => line.kind === "not_won").map((line) => line.title)).toEqual(["Dog Walking, One Month"]);
    const recap = receipt?.glim_recap as ReceiptGlimRecap;
    expect(recap).toMatchObject({ bidsPlaced: 2, allWithinLimits: true, planLots: 2, planLotsWon: 2 });
  });

  it("keeps a receipt as it was charged when a lot is edited later", async () => {
    const { event, jamie } = await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    await startSettlement({ eventId: event.id, startedBySessionId: null }, noPaypal);
    await processSettlementQueue(noPaypal);
    const [before] = await receiptOf(pool, event.id, jamie.paddleId);

    await pool.query("update lots set estimated_value_cents = 100, title = 'Renamed' where event_id = $1 and number = 12", [event.id]);
    await processSettlementQueue(noPaypal);

    expect((await receiptOf(pool, event.id, jamie.paddleId))[0]).toEqual(before);
  });
});

describe("the ledger while bidding runs", () => {
  it("shows what each bidder would pay if it ended now, with the checks undecided", async () => {
    await createFixtureEvent({ moment: "paddle", on: "2026-11-07" }, pool);
    const view = await ledger();

    expect(view.phase).toBe("live");
    expect(view.counts).toMatchObject({ all: 86 });
    expect(view.lots.closed).toBeLessThan(view.lots.total);
    expect(view.totals.toChargeCents).toBe(772_000);
    expect(view.checks).toMatchObject({ passed: null });
    expect(view.checks.checks.every((check) => check.passed === null)).toBe(true);
    expect(view.rows.find((row) => row.paddleNumber === 142)).toMatchObject({ toChargeCents: 47_000, toReleaseCents: 3_000, item: null });
  });
});

describe("the ledger as a charge finishes", () => {
  it("never reads charged over rows still queued, when the queue finishes between its reads", async () => {
    const gala = await runGala(pool, null, { simulated: [{ number: 175, holdCents: 50_000 }], wins: [{ number: 175, lot: 1, cents: 10_000 }] });
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, noPaypal);

    // The queue finishes right after the rows are read, and a settlement read still to come sees it.
    let rowsRead: Promise<unknown> | null = null;
    const racing: Queryable = {
      query: (async (text: string, values: unknown[]) => {
        if (text.includes("from settlements") && rowsRead) await rowsRead;
        if (!text.includes("from paddles p")) return pool.query(text, values);
        const rows = pool.query(text, values);
        rowsRead = rows.then(() => processSettlementQueue(noPaypal));
        await rowsRead;
        return rows;
      }) as Queryable["query"],
    };

    const view = await getLedgerView(gala.slug, racing);
    expect(view?.phase).toBe("charging");
    expect(view?.settlement?.status).toBe("running");

    // The page keeps polling while it reads charging, and the next read has it all.
    const next = await ledger(gala.slug);
    expect(next.phase).toBe("charged");
    expect(next.rows.every((row) => row.item?.status === "succeeded")).toBe(true);
  });
});

describe("a gala with real holds", () => {
  it("leaves PayPal's check undecided until the page asks, and names a real guest by first name only", async () => {
    const world = paypalWorld();
    const gala = await runGala(pool, world, {
      real: [{ number: 142, holdCents: 50_000 }],
      simulated: [{ number: 175, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    await pool.query("update paddles set first_name = 'Sam', last_initial = null where id = $1", [gala.paddles.get(142)]);

    const view = await ledger(gala.slug);

    expect(view.phase).toBe("ready");
    expect(view.holds).toEqual({ real: 1, simulated: 1 });
    expect(view.checks.passed).toBeNull();
    expect(view.checks.checks.find((check) => check.key === "holds_valid")).toMatchObject({ passed: null, count: 1 });
    expect(view.rows[0]).toMatchObject({ bidder: "Sam", lotsWon: "Lot 7", holdKind: "paypal", toChargeCents: 32_000 });
    expect(world.paypal.apiRequests()).toHaveLength(0);
  });

  it("carries a transaction id and a failed row through to the view", async () => {
    const world = paypalWorld();
    const payments: Payments = world.payments;
    const deps = dependenciesFor(pool, db, payments);
    const gala = await runGala(pool, world, {
      real: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 50_000 },
      ],
      wins: [
        { number: 142, lot: 7, cents: 32_000 },
        { number: 143, lot: 9, cents: 22_000 },
      ],
    });
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    world.failNext("capture", gala.holds.get(143)?.authorizationId ?? "", () => ({
      status: 422,
      headers: { "paypal-debug-id": "debug" },
      body: JSON.stringify({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] }),
    }));
    await processSettlementQueue(deps);

    const view = await ledger(gala.slug);
    expect(view.phase).toBe("failed");
    expect(view.settlement).toMatchObject({ status: "done_with_errors", winners: 2, winnersSettled: 1, chargedCents: 32_000, failed: 1, active: 0 });
    expect(view.rows.find((row) => row.paddleNumber === 142)?.item).toMatchObject({ status: "succeeded", paypalCaptureId: world.captures[0]?.captureId });
    expect(view.rows.find((row) => row.paddleNumber === 143)?.item).toMatchObject({ status: "failed", errorCode: "INSTRUMENT_DECLINED", paypalCaptureId: null });
  });

  it("reads the close the event really had, after Close bidding now", async () => {
    const gala = await runGala(pool, null, { live: true, simulated: [{ number: 175, holdCents: 50_000 }], wins: [{ number: 175, lot: 1, cents: 10_000 }] });
    const before = await ledger(gala.slug);
    await closeEvent(gala.eventId, { pool });
    const after = await ledger(gala.slug);
    expect(after.phase).toBe("ready");
    expect(after.event.closesAt).toBeLessThan(before.event.closesAt);
  });

  it("reads as ended for a demo retired before anyone charged it", async () => {
    const gala = await runGala(pool, null, { simulated: [{ number: 175, holdCents: 50_000 }] });
    await pool.query("update events set status = 'settled', settled_at = now() where id = $1", [gala.eventId]);
    expect((await ledger(gala.slug)).phase).toBe("ended");
  });

  it("is null for an unknown event", async () => {
    await expect(getLedgerView("no-such-event", pool)).resolves.toBeNull();
  });
});

describe("receipts", () => {
  it("are written once: a second write changes nothing", async () => {
    const gala = await runGala(pool, null, { simulated: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    const paddleId = gala.paddles.get(142) ?? "";
    const input = {
      eventId: gala.eventId,
      paddleId,
      paddleNumber: 142,
      holdCents: 50_000,
      holdAuthorizedAt: null,
      paidCents: 32_000,
      captureId: "FIRST",
      issuedAt: new Date("2026-11-08T05:31:00Z"),
    };
    await writeReceipt(pool, input);
    await writeReceipt(pool, { ...input, paidCents: 1, captureId: "SECOND" });

    const receipts = await receiptOf(pool, gala.eventId, paddleId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ paid_cents: 32_000, released_cents: 18_000, paypal_capture_id: "FIRST" });
  });

  it("says a lot with no estimated value yields no deductible, not the whole payment", async () => {
    const world = paypalWorld();
    const deps = dependenciesFor(pool, db, world.payments);
    const gala = await runGala(pool, world, {
      real: [{ number: 142, holdCents: 50_000 }],
      wins: [
        { number: 142, lot: 7, cents: 32_000 },
        { number: 142, lot: 12, cents: 9_000 },
      ],
    });
    await pool.query("update lots set estimated_value_cents = 7000 where id = $1", [gala.lots.get(12)]);
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    await processSettlementQueue(deps);

    const [receipt] = await receiptOf(pool, gala.eventId, gala.paddles.get(142) ?? "");
    expect(receipt).toMatchObject({ paid_cents: 41_000, released_cents: 9_000, deductible_cents: 2_000, paypal_capture_id: world.captures[0]?.captureId });
    const lines = (receipt?.lines ?? []) as ReceiptWonLine[];
    expect(lines.map((line) => [line.lotNumber, line.estimatedValueCents, line.deductibleCents, line.bidBy, line.limitCents])).toEqual([
      [7, null, 0, "guest", null],
      [12, 7_000, 2_000, "guest", null],
    ]);
    expect(receipt?.glim_recap).toBeNull();
  });
});
