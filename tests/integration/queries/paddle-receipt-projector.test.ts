/**
 * 10, 11 and 14 read from Postgres as the approved screens show the seeded evening: My paddle at
 * 9:15:40, the receipt before and after the organizer's charge, and the projector live and closed.
 */
import { describe, expect, it } from "vitest";

import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { pausePlan } from "@/server/plans/pause";
import { buildPaddleView, getPaddleSeed } from "@/server/queries/paddle";
import { buildProjectorView, getProjectorSeed } from "@/server/queries/projector";
import { getReceiptView } from "@/server/queries/receipt-view";
import { processSettlementQueue, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

async function paddleView(paddleNumber = 142) {
  const seed = await getPaddleSeed({ slug: FIXTURE_SLUG, paddleNumber });
  if (!seed) throw new Error("no paddle seed");
  return { seed, view: buildPaddleView(seed) };
}

describe("My paddle (10) on the seeded evening", () => {
  it("reads 10's figures, rows and Glim's feed at 9:15:40", async () => {
    await createFixtureEvent({ moment: "paddle" }, pool);
    const { view } = await paddleView();
    expect(view.money).toMatchObject({ holdCents: 50_000, inWinningCents: 47_000, leftCents: 3_000, roomNote: "Glim’s room on Spa Day" });
    expect(view.rows.map((row) => [row.number, row.note.text, row.note.tail])).toEqual([
      [7, "Glim’s limit", "reached"],
      [12, "Glim’s limit", "$30 of room left"],
      [21, "Not in Glim’s plan · outbid", null],
    ]);
    expect(view.glim.duty.kind).toBe("on");
    expect(view.glim.feed.map((entry) => [entry.label, entry.line, entry.chip])).toEqual([
      ["CHEF’S TABLE", "Someone bid $360. I raised to $380, your limit for this lot.", { kind: "winning", amountCents: 38_000 }],
      ["DOG WALKING", "Bidding closed at $95. You didn’t win, so you won’t be charged.", { kind: "closed" }],
      ["SPA DAY", "I bid $90 for you. I’ll go up to $120.", { kind: "winning", amountCents: 9_000 }],
      ["PLAN STARTED", "Chef’s Table up to $380, Spa Day up to $120.", null],
    ]);
  });

  it("follows a pause, and a raise waiting in a PayPal window", async () => {
    const fixture = await createFixtureEvent({ moment: "paddle" }, pool);
    await expect(pausePlan({ paddleId: fixture.jamie.paddleId, pool })).resolves.toMatchObject({ ok: true });
    await pool.query(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status) values ($1, $2, 'paypal', 80000, 'pending_approval')`,
      [fixture.event.id, fixture.jamie.paddleId],
    );
    const { view } = await paddleView();
    expect(view.glim.duty.kind).toBe("paused");
    // The fixture's evening is seeded ahead of the real clock, so the pause sorts by its real time.
    expect(view.glim.feed).toContainEqual(
      expect.objectContaining({ label: "PAUSED", line: "I won’t bid or change your plan until you resume. Your bids stand.", chip: null }),
    );
    expect(view.rows.slice(0, 2).map((row) => row.note.tail)).toEqual(["paused", "paused"]);
    expect(view.money.raisePending).toBe(true);
  });

  it("shows a guest with a hold and no bids as 23 state 1 draws it", async () => {
    await createFixtureEvent({ moment: "paddle" }, pool);
    const { view } = await paddleView(158);
    expect(view.rows).toEqual([]);
    expect(view.money).toMatchObject({ inWinningCents: 0, leftCents: 50_000, hasBids: false });
    expect(view.glim).toMatchObject({ duty: { kind: "idle" }, feed: [] });
  });
});

describe("the receipt (11) around the organizer's charge", () => {
  it("is pending with what Jamie will pay, then paid from the snapshot settlement writes", async () => {
    const fixture = await createFixtureEvent({ moment: "closed" }, pool);
    const pending = await getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 142 });
    expect(pending).toMatchObject({ phase: "pending", payCents: 47_000, releaseCents: 3_000, deductibleCents: 2_000, receipt: null });
    expect(pending?.won.map((lot) => [lot.number, lot.paidCents, lot.bidBy, lot.limitCents])).toEqual([
      [7, 38_000, "glim", 38_000],
      [12, 9_000, "glim", 12_000],
    ]);
    expect(pending?.notWon.map((lot) => lot.number)).toEqual([21]);
    expect(pending?.glim).toMatchObject({ bidsPlaced: 2, allWithinLimits: true, planLots: 2, planLotsWon: 2 });
    expect(pending?.event.statementLabel).toBe("PAYPAL *RIVERSIDEGALA");

    const loser = await getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 183 });
    expect(loser).toMatchObject({ phase: "release_pending", payCents: 0, won: [] });

    await expect(startSettlement({ eventId: fixture.event.id, startedBySessionId: null })).resolves.toMatchObject({ kind: "started" });
    await processSettlementQueue();

    const paid = await getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 142 });
    expect(paid).toMatchObject({ phase: "paid", payCents: 47_000, releaseCents: 3_000, deductibleCents: 2_000 });
    expect(paid?.receipt?.number).toMatch(/^\d{4}-142$/);
    expect(paid?.won.map((lot) => [lot.number, lot.paidCents, lot.deductibleCents])).toEqual([
      [7, 38_000, 0],
      [12, 9_000, 2_000],
    ]);
    const released = await getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 183 });
    expect(released).toMatchObject({ phase: "released", payCents: 0 });
    expect(released?.releasedAt).not.toBeNull();
  });

  it("has no phase while bidding is open", async () => {
    await createFixtureEvent({ moment: "paddle" }, pool);
    await expect(getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 142 })).resolves.toMatchObject({ phase: null });
    await expect(getReceiptView({ slug: FIXTURE_SLUG, paddleNumber: 999 })).resolves.toBeNull();
  });
});

describe("the projector (14)", () => {
  it("reads 14's room, leaders and Glim's counts at 9:15:40, and 26's after the close", async () => {
    const live = await createFixtureEvent({ moment: "paddle" }, pool);
    const seed = await getProjectorSeed(FIXTURE_SLUG);
    if (!seed) throw new Error("no projector seed");
    const view = buildProjectorView({ records: seed, extras: seed, now: live.at.getTime() });
    expect(view).toMatchObject({ phase: "live", lotCount: 24, bidderCount: 86, raisedCents: 772_000, isDemo: false });
    expect(view.glim).toEqual({ guests: 29, bids: 84, withinLimits: true });
    expect(view.first).toMatchObject({ number: 7, priceCents: 38_000, leader: { paddleNumber: 142, byGlim: true } });
    expect(view.rows.map((row) => row.number)).toEqual([18, 12, 14]);
    expect(view.note).toMatchObject({ kind: "more", count: 16, sameTime: true });

    const closed = await createFixtureEvent({ moment: "closed" }, pool);
    const after = await getProjectorSeed(FIXTURE_SLUG);
    if (!after) throw new Error("no projector seed");
    const ended = buildProjectorView({ records: after, extras: after, now: closed.at.getTime() });
    expect(ended).toMatchObject({ phase: "after", soldCount: 23, raisedCents: 816_000, note: { kind: "sold", count: 19 } });
    expect(ended.glim).toEqual({ guests: 31, bids: 96, withinLimits: true });
    expect(ended.first).toMatchObject({ number: 1, priceCents: 145_000, leader: { paddleNumber: 175, byGlim: false } });
    expect(ended.rows[2]).toMatchObject({ number: 4, leader: { paddleNumber: 121, byGlim: true } });
  });

  it("knows a demo gala, for C6's Sandbox marker and line", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    await expect(getProjectorSeed(event.slug)).resolves.toMatchObject({ isDemo: true });
    await expect(getProjectorSeed("no-such-gala")).resolves.toBeNull();
  });
});
