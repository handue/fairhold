import { describe, expect, it } from "vitest";

import type { InsightsLot, InsightsView } from "@/server/settlement/types";
import { chartTop, insightsCopy, limitBarHeight, raisedChart, sparkline, topLotRows } from "@/ui/organizer/insights-model";

const opensAt = Date.parse("2026-11-08T03:00:00Z"); // 7:00 PM in Los Angeles
const closesAt = Date.parse("2026-11-08T05:30:00Z"); // 9:30 PM
const TEN_MINUTES = 10 * 60_000;

/** design/28's line, read back from its own points: 16 instants ten minutes apart. */
const BOARD_Y = [194.0, 169.6, 143.2, 132.8, 120.3, 111.2, 101.4, 89.9, 80.8, 72.8, 58.4, 50.7, 36.7, 20.3, 16.4, 6.3];
const boardPoints = BOARD_Y.map((y, index) => ({ at: opensAt + index * TEN_MINUTES, cents: Math.round(((194 - y) / 184) * 800_000) }));
boardPoints[15] = { at: closesAt, cents: 816_000 };

function lot(overrides: Partial<InsightsLot> = {}): InsightsLot {
  return { number: 1, title: "Name the Next Shelter Puppy", amountCents: 145_000, estimatedValueCents: 0, bids: 18, paddleNumber: 175, glim: false, closed: true, ...overrides };
}

function view(overrides: Partial<InsightsView> = {}): InsightsView {
  return {
    event: {
      slug: "gala",
      name: "Riverside Shelter Gala",
      charityName: "Riverside Animal Shelter",
      timeZone: "America/Los_Angeles",
      status: "settled",
      opensAt,
      closesAt,
      isDemo: true,
      dateLabel: "Saturday, November 7, 2026",
    },
    phase: "charged",
    now: closesAt,
    bidders: 86,
    simulatedBidders: 85,
    saySimulated: true,
    raisedCents: 816_000,
    raised: boardPoints,
    window: { opensAt, closesAt },
    lots: { total: 24, sold: 23, open: 0, withoutBids: [{ number: 22, title: "Golf Lesson with a Pro" }] },
    bids: { total: 306, glim: 96 },
    winners: { count: 19, glim: 9 },
    limits: { shares: [...Array<number>(24).fill(1), 0.956, 0.75], reached: 24, passed: 0, glimBids: 96, glimBidsWithin: 96 },
    holds: { heldCents: 4_395_000, chargedCents: 816_000, winnerHoldCents: 1_150_000, winnerShares: [0.94, 0.8, 0.52], nonWinners: 67 },
    lotRows: [lot(), lot({ number: 22, title: "Golf Lesson with a Pro", amountCents: null, bids: 0, paddleNumber: null })],
    ...overrides,
  };
}

describe("Insights as drawn (design/28), once charged", () => {
  it("says exactly what the board says", () => {
    expect(insightsCopy(view())).toEqual({
      note: "85 of the 86 bidders are simulated guests.",
      kpis: [
        { label: "Raised", value: "$8,160", cents: 816_000, of: null, sub: "for Riverside Animal Shelter" },
        { label: "Lots sold", value: "23", cents: null, of: "of 24", sub: "Lot 22 had no bids" },
        { label: "Bids", value: "306", cents: null, of: null, sub: "96 of them by Glim" },
        { label: "Winners", value: "19", cents: null, of: "of 86", sub: "Glim bid for 9 of the 19" },
      ],
      limits: { figure: "96 of 96", sub: "bids by Glim stayed within their limits", foot: ["26 limits", "24 reached", "0 passed"] },
      holds: {
        figure: "19%",
        sub: "of the $43,950 held was charged",
        ends: ["94%", "52%"],
        foot: "The 3 winners used 71% of their holds. The other 67 had theirs released in full.",
      },
      topLots: { note: "1 of 23 sold", amountHeader: "Sold for" },
    });
  });

  it("only says which bidders are simulated where the screen should", () => {
    expect(insightsCopy(view({ saySimulated: false })).note).toBeNull();
    expect(insightsCopy(view({ simulatedBidders: 85, bidders: 85 })).note).toBe("All 85 bidders are simulated guests.");
    expect(insightsCopy(view({ simulatedBidders: 1, bidders: 2 })).note).toBe("1 of the 2 bidders is a simulated guest.");
  });

  it("never uses a word the brand rules forbid", () => {
    for (const phase of ["live", "ready", "charged"] as const) {
      expect(JSON.stringify(insightsCopy(view({ phase }))).toLowerCase()).not.toMatch(/\bfmv\b|\birs\b|guarantee|tax|fair market/);
    }
  });
});

describe("Insights before the charge, and while bidding runs", () => {
  it("says what will be charged before it has been", () => {
    const copy = insightsCopy(view({ phase: "ready" }));
    expect(copy.holds.sub).toBe("of the $43,950 held will be charged");
    expect(copy.holds.foot).toBe("The 3 winners will use 71% of their holds. The other 67 will have theirs released in full.");
  });

  it("says what is bid now while bidding runs, and ranks the lots with bids", () => {
    const live = view({
      phase: "live",
      lots: { total: 24, sold: 0, open: 20, withoutBids: [] },
      lotRows: [lot({ closed: false }), lot({ number: 2, closed: false, amountCents: 70_000 }), lot({ number: 3, closed: false, amountCents: null, bids: 0, paddleNumber: null })],
    });
    const copy = insightsCopy(live);
    expect(copy.kpis[1].sub).toBe("20 lots still open");
    expect(copy.holds.sub).toBe("of the $43,950 held is bid now");
    expect(copy.topLots).toEqual({ note: "2 of 2 with bids", amountHeader: "High bid" });
    expect(topLotRows(live).map((row) => row.number)).toEqual([1, 2]);
  });

  it("says so when Glim has not bid", () => {
    const copy = insightsCopy(view({ bids: { total: 12, glim: 0 }, winners: { count: 3, glim: 0 }, limits: { shares: [], reached: 0, passed: 0, glimBids: 0, glimBidsWithin: 0 } }));
    expect(copy.kpis[2].sub).toBe("None by Glim");
    expect(copy.kpis[3].sub).toBe("Glim bid for none of them");
    expect(copy.limits).toEqual({ figure: "0 of 0", sub: "Glim hasn’t bid yet", foot: ["0 limits", "0 reached", "0 passed"] });
  });

  it("ranks only lots that sold, once bidding closed", () => {
    expect(topLotRows(view()).map((row) => row.number)).toEqual([1]);
  });
});

describe("Raised through the evening", () => {
  it("draws the board's chart from the board's points", () => {
    const chart = raisedChart(boardPoints, { opensAt, closesAt }, "America/Los_Angeles");
    expect(chart.gridlines).toEqual([
      { y: 194, label: "$0" },
      { y: 148, label: "$2,000" },
      { y: 102, label: "$4,000" },
      { y: 56, label: "$6,000" },
      { y: 10, label: "$8,000" },
    ]);
    expect(chart.xLabels.map((label) => [label.text, Number(label.x.toFixed(1)), label.anchor])).toEqual([
      ["7:00 PM", 52, "start"],
      ["7:30", 185.6, "middle"],
      ["8:00", 319.2, "middle"],
      ["8:30", 452.8, "middle"],
      ["9:00", 586.4, "middle"],
      ["9:30 PM", 720, "end"],
    ]);
    const ys = chart.line
      .slice(1)
      .split("L")
      .map((point) => Number(point.split(" ")[1]));
    ys.forEach((y, index) => expect(y).toBeCloseTo(BOARD_Y[index] ?? 0, 0));
    expect(chart.line.startsWith("M52.0 194.0L96.5 ")).toBe(true);
    expect(chart.area.endsWith("L720.0 194.0L52.0 194.0Z")).toBe(true);
    expect(chart.end).toMatchObject({ x: 720, label: "$8,160" });
    expect(chart.end?.y).toBeCloseTo(6.3, 1);
    expect(chart.aria).toBe("Raised through the evening, from $0 at 7:00 PM to $8,160 at 9:30 PM");
  });

  it("draws the same chart at its widget's width below 1440, the round times thinning with the room", () => {
    const zone = "America/Los_Angeles";
    expect(raisedChart(boardPoints, { opensAt, closesAt }, zone, 778)).toEqual(raisedChart(boardPoints, { opensAt, closesAt }, zone));

    // A phone's widget: the plot keeps its 52 and 58 margins, and only the ends are named.
    const phone = raisedChart(boardPoints, { opensAt, closesAt }, zone, 303);
    expect(phone.right).toBe(245);
    expect(phone.xLabels.map((label) => [label.text, Number(label.x.toFixed(1))])).toEqual([
      ["7:00 PM", 52],
      ["9:30 PM", 245],
    ]);
    expect(phone.end).toMatchObject({ x: 245, label: "$8,160" });
    expect(phone.gridlines).toEqual(raisedChart(boardPoints, { opensAt, closesAt }, zone).gridlines);

    // A tablet's: every hour; no label within 80 of an end.
    const tablet = raisedChart(boardPoints, { opensAt, closesAt }, zone, 656);
    expect(tablet.xLabels.map((label) => label.text)).toEqual(["7:00 PM", "8:00", "9:00", "9:30 PM"]);
    for (const label of tablet.xLabels.slice(1, -1)) {
      expect(label.x - 52).toBeGreaterThanOrEqual(80);
      expect(tablet.right - label.x).toBeGreaterThanOrEqual(80);
    }
    // Never narrower than its floor.
    expect(raisedChart(boardPoints, { opensAt, closesAt }, zone, 100).right).toBe(162);
  });

  it("keeps the line under the svg's top for any evening's figure", () => {
    for (const max of [0, 1, 9_999, 75_000, 682_000, 816_000, 1_000_000, 12_345_678]) {
      const top = chartTop(max);
      expect(top).toBeGreaterThanOrEqual(max * 0.95);
      expect(max / top).toBeLessThan(1.06);
    }
    expect(chartTop(816_000)).toBe(800_000);
    expect(chartTop(682_000)).toBe(800_000);
  });

  it("ends the line at now while bidding runs, on an axis that runs to the close", () => {
    const now = opensAt + 75 * 60_000;
    const chart = raisedChart([{ at: opensAt, cents: 0 }, { at: now, cents: 300_000 }], { opensAt, closesAt }, "America/Los_Angeles");
    expect(chart.end?.x).toBeCloseTo(386, 0);
    expect(chart.xLabels.at(-1)?.text).toBe("9:30 PM");
  });

  it("labels a short demo's axis without crowding its ends", () => {
    const start = Date.parse("2026-11-09T19:12:34Z");
    const chart = raisedChart([{ at: start, cents: 0 }], { opensAt: start, closesAt: start + 25 * 60_000 }, "America/Los_Angeles");
    const xs = chart.xLabels.map((label) => label.x);
    for (let index = 1; index < xs.length; index += 1) expect((xs[index] ?? 0) - (xs[index - 1] ?? 0)).toBeGreaterThanOrEqual(56);
    expect(chart.xLabels[0]?.text).toBe("11:12 AM");
  });

  it("keeps a long window's axis to a few labels", () => {
    // The seeded evening read days later on the real clock: about 40 hours from open to close.
    const start = Date.parse("2026-11-08T03:00:00Z");
    const chart = raisedChart([{ at: start, cents: 0 }], { opensAt: start, closesAt: start + 40 * 60 * 60_000 }, "America/Los_Angeles");
    expect(chart.xLabels.length).toBeLessThanOrEqual(7);
    const xs = chart.xLabels.map((label) => label.x);
    for (let index = 1; index < xs.length; index += 1) expect((xs[index] ?? 0) - (xs[index - 1] ?? 0)).toBeGreaterThanOrEqual(80);
  });

  it("leaves out a round time that would run into the close's label", () => {
    // A demo closed early: 10:41 AM to 12:40 PM, where 12:30 sat 56 units from "12:40 PM" and overlapped it.
    const start = Date.parse("2026-11-09T18:41:20Z");
    const chart = raisedChart([{ at: start, cents: 0 }], { opensAt: start, closesAt: start + 119 * 60_000 }, "America/Los_Angeles");
    expect(chart.xLabels.map((label) => label.text)).toEqual(["10:41 AM", "11:00", "11:30", "12:00", "12:40 PM"]);
  });

  it("draws the Raised widget's sparkline as drawn: 108 across, the figure at 3", () => {
    const spark = sparkline(boardPoints, { opensAt, closesAt });
    expect(spark?.end).toEqual({ x: 108, y: 3 });
    expect(spark?.path.startsWith("M0.0 37.0L7.2 32.6")).toBe(true);
    expect(sparkline([], { opensAt, closesAt })).toBeNull();
  });

  it("fills a limit's bar to its share, and lets one that crossed the line show it", () => {
    expect(limitBarHeight(1)).toBe("100%");
    expect(limitBarHeight(0.956)).toBe("95.6%");
    expect(limitBarHeight(3)).toBe("110%");
  });
});
