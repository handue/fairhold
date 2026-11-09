import { describe, expect, it } from "vitest";

import type { StreamEvent } from "@/server/sse/types";

import { buildProjectorView, foldProjectorExtras, projectorPhase, type ProjectorSeed } from "./projector-view";
import type { LotRecord } from "./types";

const NOW = Date.parse("2026-11-08T05:15:40Z");
const NINE_THIRTY = Date.parse("2026-11-08T05:30:00Z");

function lot(number: number, overrides: Partial<LotRecord> = {}): LotRecord {
  return {
    id: `lot-${number}`,
    number,
    category: "dining",
    title: `Lot ${number}`,
    shortTitle: `Lot ${number}`,
    donorName: "Donor",
    estimatedValueCents: null,
    startingBidCents: 5_000,
    minRaiseCents: 1_000,
    currentBidCents: null,
    bidCount: 0,
    closesAt: NINE_THIRTY,
    status: "open",
    highPaddleId: null,
    winningPaddleId: null,
    winningCents: null,
    coverDrawing: null,
    ...overrides,
  };
}

function seed(lots: LotRecord[], overrides: Partial<ProjectorSeed> = {}): ProjectorSeed {
  return {
    streamPosition: "50",
    now: NOW,
    event: {
      id: "event",
      slug: "gala",
      name: "Riverside Shelter Gala",
      charityName: "Riverside Animal Shelter",
      timeZone: "America/Los_Angeles",
      status: "live",
      opensAt: NOW - 8_000_000,
      closesAt: NINE_THIRTY,
    },
    lots,
    paddle: null,
    viewerLots: [],
    leaders: {},
    bidderIds: ["a", "b"],
    glimPaddleIds: ["a"],
    glimBids: 3,
    glimWithinLimits: true,
    isDemo: false,
    pickupNote: "Show this receipt at the front desk by 10 PM.",
    ...overrides,
  };
}

const view = (records: ProjectorSeed, now = NOW) => buildProjectorView({ records, extras: records, now });

describe("buildProjectorView", () => {
  it("lists the four open lots that close first, and the rest that close together at 9:30 (14)", () => {
    const lots = [
      lot(7, { closesAt: NOW + 62_000, currentBidCents: 38_000, bidCount: 14, highPaddleId: "a" }),
      lot(18, { closesAt: NOW + 275_000, currentBidCents: 15_000, bidCount: 3 }),
      lot(12, { closesAt: NOW + 510_000, currentBidCents: 9_000, bidCount: 5 }),
      lot(14, { closesAt: NOW + 840_000, currentBidCents: 30_000, bidCount: 2 }),
      ...Array.from({ length: 16 }, (_, index) => lot(30 + index)),
      lot(21, { status: "closed", winningPaddleId: "b", winningCents: 9_500, currentBidCents: 9_500, closesAt: NOW - 140_000 }),
    ];
    const result = view(seed(lots));
    expect(result.phase).toBe("live");
    expect(result.first?.number).toBe(7);
    expect(result.rows.map((row) => row.number)).toEqual([18, 12, 14]);
    expect(result.note).toEqual({ kind: "more", count: 16, at: NINE_THIRTY, sameTime: true });
    expect(result.raisedCents).toBe(38_000 + 15_000 + 9_000 + 30_000 + 9_500);
    expect(result.bidderCount).toBe(2);
    expect(result.glim).toEqual({ guests: 1, bids: 3, withinLimits: true });
  });

  it("counts down the last lots without a 'more' (26 states 3 and 4)", () => {
    expect(view(seed([lot(22), lot(23), lot(24)])).note).toEqual({ kind: "last", count: 3 });
    const last = view(seed([lot(24), lot(23, { status: "closed" })]));
    expect(last.note).toEqual({ kind: "last", count: 1 });
    expect(last.rows).toEqual([]);
  });

  it("before opening, lists every lot by close at its starting bid, the rest 'by' the last close (26 state 1)", () => {
    const minutesBefore = (minutes: number) => NINE_THIRTY - minutes * 60_000;
    const scheduled = seed([lot(3, { closesAt: minutesBefore(24) }), lot(5, { closesAt: minutesBefore(22) }), lot(1, { closesAt: minutesBefore(20) }), lot(2, { closesAt: minutesBefore(18) }), lot(4, { closesAt: minutesBefore(10) }), lot(9)], {
      event: { ...seed([]).event, status: "scheduled", opensAt: NOW + 750_000 },
    });
    const result = view(scheduled);
    expect(result.phase).toBe("before");
    expect(result.first).toMatchObject({ number: 3, priceCents: 5_000, leader: null });
    expect(result.note).toEqual({ kind: "more", count: 2, at: NINE_THIRTY, sameTime: false });
  });

  it("after the close, ranks the sold lots by what they raised, with who won them (26 state 2)", () => {
    const sold = (number: number, cents: number) =>
      lot(number, { status: "closed", winningPaddleId: `p${number}`, winningCents: cents, currentBidCents: cents, bidCount: 4 });
    const records = seed([sold(1, 145_000), sold(2, 78_000), sold(3, 72_000), sold(4, 60_000), sold(5, 17_000), lot(22, { status: "closed" })], {
      event: { ...seed([]).event, status: "closed" },
      leaders: { "lot-4": { paddleNumber: 121, byGlim: true } },
    });
    const result = view(records);
    expect(result.phase).toBe("after");
    expect(result.first).toMatchObject({ number: 1, priceCents: 145_000 });
    expect(result.rows.map((row) => row.number)).toEqual([2, 3, 4]);
    expect(result.rows[2]?.leader).toEqual({ paddleNumber: 121, byGlim: true });
    expect(result.note).toEqual({ kind: "sold", count: 1 });
    expect(result.soldCount).toBe(5);
    expect(result.raisedCents).toBe(145_000 + 78_000 + 72_000 + 60_000 + 17_000);
  });

  it("is before opening until the clock reaches the opening, whatever the status", () => {
    expect(projectorPhase({ status: "live", opensAt: NOW + 1 }, NOW)).toBe("before");
    expect(projectorPhase({ status: "live", opensAt: NOW }, NOW)).toBe("live");
    expect(projectorPhase({ status: "settled", opensAt: NOW + 1 }, NOW)).toBe("after");
  });
});

describe("foldProjectorExtras", () => {
  const placed = (id: string, bids: Array<{ paddleId: string; paddleNumber: number; amountCents: number; source: "guest" | "glim" | "bot" | "guest_max" }>): StreamEvent => {
    const top = bids.reduce((best, bid) => (bid.amountCents > best.amountCents ? bid : best));
    return {
      id,
      type: "bid",
      paddleId: null,
      at: NOW,
      payload: {
        kind: "bids_placed",
        lotId: "lot-7",
        lotNumber: 7,
        bids: bids.map((bid, index) => ({ bidId: `${id}-${index}`, ...bid })),
        currentBidCents: top.amountCents,
        bidCount: 15,
        highPaddleId: top.paddleId,
        highPaddleNumber: top.paddleNumber,
        nextMinimumCents: top.amountCents + 2_000,
      },
    } as StreamEvent;
  };

  it("takes the leader, the bidders and Glim's bids from rows after the seed", () => {
    const records = seed([lot(7)]);
    const folded = foldProjectorExtras(records, [
      placed("40", [{ paddleId: "z", paddleNumber: 199, amountCents: 99_000, source: "guest" }]),
      placed("51", [
        { paddleId: "c", paddleNumber: 88, amountCents: 36_000, source: "bot" },
        { paddleId: "d", paddleNumber: 142, amountCents: 38_000, source: "glim" },
      ]),
    ]);
    expect(folded.leaders["lot-7"]).toEqual({ paddleNumber: 142, byGlim: true });
    expect([...folded.bidderIds].sort()).toEqual(["a", "b", "c", "d"]);
    expect([...folded.glimPaddleIds].sort()).toEqual(["a", "d"]);
    expect(folded.glimBids).toBe(4);
  });

  it("returns the seed itself when nothing new arrived", () => {
    const records = seed([lot(7)]);
    expect(foldProjectorExtras(records, [placed("50", [{ paddleId: "z", paddleNumber: 1, amountCents: 1, source: "glim" }])])).toBe(records);
  });
});
