import { describe, expect, it } from "vitest";

import { buildPaddleView, changesPaddlePage, NO_GLIM_RECORDS, type PaddleGlimRecords, type PaddleSeed } from "./paddle-view";
import type { LotRecord, ViewerLotRecord } from "./types";

const NOW = Date.parse("2026-11-08T05:15:40Z");
const ME = "paddle-142";

function lot(overrides: Partial<LotRecord> & Pick<LotRecord, "id" | "number">): LotRecord {
  return {
    category: "dining",
    title: `Lot ${overrides.number}`,
    shortTitle: `Lot ${overrides.number}`,
    donorName: "Donor",
    estimatedValueCents: null,
    startingBidCents: 5_000,
    minRaiseCents: 1_000,
    currentBidCents: null,
    bidCount: 0,
    closesAt: NOW + 60_000,
    status: "open",
    highPaddleId: null,
    winningPaddleId: null,
    winningCents: null,
    coverDrawing: null,
    ...overrides,
  };
}

const relation = (lotId: string, overrides: Partial<ViewerLotRecord> = {}): ViewerLotRecord => ({
  lotId,
  hasBid: true,
  isFavorite: false,
  inGlimPlan: false,
  limitCents: null,
  ...overrides,
});

/** 10 at 9:15:40: Chef's Table at Glim's $380 limit, Spa Day with $30 of room, Dog Walking lost. */
const CHEF = lot({ id: "lot-07", number: 7, shortTitle: "Chef’s Table", currentBidCents: 38_000, bidCount: 14, highPaddleId: ME, closesAt: NOW + 62_000 });
const SPA = lot({ id: "lot-12", number: 12, shortTitle: "Spa Day", category: "wellness", currentBidCents: 9_000, bidCount: 5, highPaddleId: ME, closesAt: NOW + 510_000 });
const DOG = lot({
  id: "lot-21",
  number: 21,
  category: "pets",
  status: "closed",
  currentBidCents: 9_500,
  winningPaddleId: "paddle-other",
  winningCents: 9_500,
  closesAt: NOW - 140_000,
});
const HEARTED = lot({ id: "lot-03", number: 3 });

const RUNNING: PaddleGlimRecords = {
  plan: {
    status: "active",
    pausedAt: null,
    armed: false,
    items: [
      { lotId: "lot-07", maxCents: 38_000, skipped: false },
      { lotId: "lot-12", maxCents: 12_000, skipped: false },
    ],
  },
  onDutySince: NOW - 260_000,
  autopilotOn: true,
  feed: [],
};

function seed(overrides: Partial<PaddleSeed> = {}): PaddleSeed {
  return {
    streamPosition: "100",
    now: NOW,
    event: {
      id: "event",
      slug: "riverside-shelter-gala",
      name: "Riverside Shelter Gala",
      charityName: "Riverside Animal Shelter",
      timeZone: "America/Los_Angeles",
      status: "live",
      opensAt: NOW - 8_000_000,
      closesAt: NOW + 860_000,
    },
    lots: [HEARTED, CHEF, SPA, DOG],
    paddle: { id: ME, number: 142, firstName: "Jamie", holdCents: 50_000, holdId: "hold" },
    viewerLots: [
      relation("lot-07", { inGlimPlan: true, limitCents: 38_000 }),
      relation("lot-12", { inGlimPlan: true, limitCents: 12_000 }),
      relation("lot-21"),
      relation("lot-03", { hasBid: false, isFavorite: true }),
    ],
    glim: RUNNING,
    raisePending: false,
    ...overrides,
  };
}

describe("buildPaddleView", () => {
  it("reproduces 10's money panel: $470 in winning bids, $30 left as Glim's room on Spa Day", () => {
    const { money } = buildPaddleView(seed());
    expect(money).toEqual({
      holdCents: 50_000,
      inWinningCents: 47_000,
      leftCents: 3_000,
      roomNote: "Glim’s room on Spa Day",
      hasBids: true,
      raisePending: false,
    });
  });

  it("lists the guest's lots, open ones first by close, with 10's limit notes; a heart alone is not one", () => {
    const { rows } = buildPaddleView(seed());
    expect(rows.map((row) => row.number)).toEqual([7, 12, 21]);
    expect(rows[0]?.note).toEqual({ text: "Glim’s limit", amountCents: 38_000, tail: "reached" });
    expect(rows[1]?.note).toEqual({ text: "Glim’s limit", amountCents: 12_000, tail: "$30 of room left" });
    expect(rows[2]).toMatchObject({
      done: true,
      soldCents: 9_500,
      note: { text: "Not in Glim’s plan · outbid", amountCents: null, tail: null },
    });
  });

  it("reads paused on every Glim limit while the plan is paused, and keeps the figures (design/23 state 2)", () => {
    const view = buildPaddleView(seed({ glim: { ...RUNNING, plan: { ...RUNNING.plan!, status: "paused", pausedAt: NOW - 40_000 } } }));
    expect(view.rows.slice(0, 2).map((row) => row.note.tail)).toEqual(["paused", "paused"]);
    expect(view.money.leftCents).toBe(3_000);
    expect(view.money.roomNote).toBe("Glim’s room on Spa Day");
    expect(view.glim.duty).toEqual({ kind: "paused", since: NOW - 40_000 });
  });

  it("shows no bids yet with Glim not bidding, and the two-line rule when a card would arm the autopilot (state 1)", () => {
    const view = buildPaddleView(seed({ lots: [HEARTED], viewerLots: [relation("lot-03", { hasBid: false, isFavorite: true })], glim: { ...NO_GLIM_RECORDS, autopilotOn: true } }));
    expect(view.rows).toEqual([]);
    expect(view.money).toMatchObject({ inWinningCents: 0, leftCents: 50_000, hasBids: false, roomNote: null });
    expect(view.glim).toEqual({ duty: { kind: "idle" }, decides: true, feed: [] });
  });

  it("keeps 10's one-line rule for a plan Start bidding did not arm", () => {
    expect(buildPaddleView(seed()).glim.decides).toBe(false);
    expect(buildPaddleView(seed({ glim: { ...RUNNING, plan: { ...RUNNING.plan!, armed: true } } })).glim.decides).toBe(true);
  });

  it("names no room when what is left is more than Glim keeps", () => {
    const view = buildPaddleView(seed({ paddle: { id: ME, number: 142, firstName: "Jamie", holdCents: 60_000 } }));
    expect(view.money.leftCents).toBe(13_000);
    expect(view.money.roomNote).toBeNull();
  });

  it("calls a guest's own max theirs, and an outbid Glim lot outbid", () => {
    const view = buildPaddleView(
      seed({
        lots: [CHEF, { ...SPA, highPaddleId: "paddle-other" }],
        viewerLots: [relation("lot-07", { limitCents: 40_000 }), relation("lot-12", { inGlimPlan: true, limitCents: null })],
        glim: { ...RUNNING, plan: { ...RUNNING.plan!, items: [{ lotId: "lot-12", maxCents: 12_000, skipped: false }] } },
      }),
    );
    expect(view.rows[0]?.note).toEqual({ text: "Your max", amountCents: 40_000, tail: "$20 of room left" });
    expect(view.rows[1]?.note).toEqual({ text: "Glim’s limit", amountCents: 12_000, tail: "outbid" });
  });

  it("counts a won lot in winning bids and keeps it out of the quiet rows", () => {
    const won = { ...DOG, winningPaddleId: ME };
    const view = buildPaddleView(seed({ lots: [won] }));
    expect(view.money.inWinningCents).toBe(9_500);
    expect(view.rows[0]).toMatchObject({ done: false, viewerStatus: "won", priceCents: 9_500, note: { text: "Not in Glim’s plan · won" } });
  });
});

describe("changesPaddlePage", () => {
  const row = (type: string, paddleId: string | null, kind?: string) => ({ type, paddleId, payload: kind ? { kind } : { status: "authorized" } });

  it("asks for the page again on the paddle's Glim and hold rows, and on the close", () => {
    expect(changesPaddlePage(row("glim", ME, "chat_card"), ME)).toBe(true);
    expect(changesPaddlePage(row("glim", ME, "plan_status"), ME)).toBe(true);
    expect(changesPaddlePage(row("glim", ME, "autopilot_finished"), ME)).toBe(true);
    expect(changesPaddlePage(row("hold", ME), ME)).toBe(true);
    expect(changesPaddlePage(row("event_status", null, "event_closed"), ME)).toBe(true);
  });

  it("leaves what the fold carries, and other paddles' rows, to the fold", () => {
    expect(changesPaddlePage(row("bid", null, "bids_placed"), ME)).toBe(false);
    expect(changesPaddlePage(row("glim", ME, "limit_raised"), ME)).toBe(false);
    expect(changesPaddlePage(row("hold", "someone-else"), ME)).toBe(false);
    expect(changesPaddlePage(row("event_status", null, "schedule_changed"), ME)).toBe(false);
  });
});
