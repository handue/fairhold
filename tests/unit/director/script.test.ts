/** The background script of a demo gala, planned from the real template and its bot profiles. */
import { describe, expect, it } from "vitest";

import { buildDemoEventPlan } from "@/server/demo/demoPlan";
import { DEMO_LENGTH_MS } from "@/server/demo/schedule";
import { planBackgroundBids } from "@/server/director/script";

const start = new Date("2026-11-08T20:00:00Z");
const plan = buildDemoEventPlan({ now: start, slug: "gala-test", timeZone: "America/Los_Angeles", creator: { firstName: "Sam", lastInitial: null } });
const bids = planBackgroundBids({ start, lots: plan.lots, paddles: plan.paddles });
const lotOf = (number: number) => {
  const lot = plan.lots.find((entry) => entry.number === number);
  if (!lot) throw new Error(`no lot ${number}`);
  return lot;
};
const offset = (at: Date) => at.getTime() - start.getTime();
const MINUTE = 60_000;

describe("planBackgroundBids", () => {
  it("fills the demo's 25 minutes from its first minute to near the end", () => {
    expect(bids.length).toBeGreaterThanOrEqual(50);
    expect(offset(bids[0]?.runAt ?? start)).toBeLessThan(90_000);
    expect(offset(bids.at(-1)?.runAt ?? start)).toBeGreaterThan(20 * MINUTE);
    expect(offset(bids.at(-1)?.runAt ?? start)).toBeLessThan(DEMO_LENGTH_MS);

    const busyMinutes = new Set(bids.map((bid) => Math.floor(offset(bid.runAt) / (5 * MINUTE))));
    expect(busyMinutes.size).toBe(5);
    const quietest = Math.max(...bids.slice(1).map((bid, index) => bid.runAt.getTime() - (bids[index]?.runAt.getTime() ?? 0)));
    expect(quietest).toBeLessThan(3 * MINUTE);
  });

  it("is the same script every time, in time order", () => {
    expect(planBackgroundBids({ start, lots: plan.lots, paddles: plan.paddles })).toEqual(bids);
    const times = bids.map((bid) => bid.runAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("changes with the seed, and moves with the demo's start", () => {
    const other = planBackgroundBids({ start, lots: plan.lots, paddles: plan.paddles, seed: "another" });
    expect(other.map((bid) => bid.runAt)).not.toEqual(bids.map((bid) => bid.runAt));

    const later = new Date(start.getTime() + 60 * MINUTE);
    const laterPlan = buildDemoEventPlan({ now: later, slug: "gala-test", timeZone: "America/Los_Angeles", creator: { firstName: "Sam", lastInitial: null } });
    const moved = planBackgroundBids({ start: later, lots: laterPlan.lots, paddles: laterPlan.paddles });
    expect(moved.map((bid) => bid.runAt.getTime() - 60 * MINUTE)).toEqual(bids.map((bid) => bid.runAt.getTime()));
  });

  it("only ever has a simulated guest bid on a lot in their profile, up to its max", () => {
    for (const bid of bids) {
      const paddle = plan.paddles.find((entry) => entry.number === bid.paddleNumber);
      expect(paddle?.isSimulated).toBe(true);
      const target = paddle?.botProfile?.targets.find((entry) => entry.lotNumber === bid.lotNumber);
      expect(target, `paddle ${bid.paddleNumber} on lot ${bid.lotNumber}`).toBeDefined();
      expect(bid.maxCents).toBeLessThanOrEqual(target?.maxCents ?? 0);
    }
  });

  it("keeps every bid before its lot closes", () => {
    for (const bid of bids) expect(bid.runAt.getTime()).toBeLessThan(lotOf(bid.lotNumber).closesAt.getTime());
  });

  it("leaves Chef's Table and Spa Day to the guest and the rivals", () => {
    expect(bids.filter((bid) => bid.lotNumber === 7 || bid.lotNumber === 12)).toEqual([]);

    // Today's profiles would leave them alone anyway; the golden path must not depend on that.
    const eager = (number: number, lotNumber: number) => ({
      number,
      botProfile: { version: 1 as const, budgetCents: 500_000, targets: [{ lotNumber, maxCents: 400_000 }], usesGlim: false, timing: "steady" as const },
    });
    const wanted = planBackgroundBids({ start, lots: plan.lots, paddles: [eager(1, 7), eager(2, 7), eager(3, 12), eager(4, 12), eager(5, 22), eager(6, 22)] });
    expect(new Set(wanted.map((bid) => bid.lotNumber))).toEqual(new Set([22]));
  });

  it("keeps Wine Tasting at $210 until +10:30, and never lets a bot go past $370 on it", () => {
    const wine = bids.filter((bid) => bid.lotNumber === 9);
    expect(wine.length).toBeGreaterThanOrEqual(3);
    for (const bid of wine) {
      expect(offset(bid.runAt)).toBeGreaterThan(10.5 * MINUTE);
      expect(bid.runAt.getTime()).toBeLessThan(lotOf(9).closesAt.getTime());
      expect(bid.maxCents).toBeLessThanOrEqual(37_000);
    }
  });

  it("has nobody bid twice in a row on a lot, and each lot's order leaves the top bidder last or ahead", () => {
    for (const lot of plan.lots) {
      const turns = bids.filter((bid) => bid.lotNumber === lot.number);
      turns.forEach((turn, index) => {
        const previous = index === 0 ? lot.highPaddleNumber : turns[index - 1]?.paddleNumber;
        expect(turn.paddleNumber).not.toBe(previous);
      });
    }
  });

  it("lets bots that the story has bidding late wait for the second half of their lot", () => {
    const allLate = [1, 6, 13];
    for (const number of allLate) {
      const turns = bids.filter((bid) => bid.lotNumber === number);
      expect(turns.length).toBeGreaterThan(0);
      for (const turn of turns) expect(offset(turn.runAt)).toBeGreaterThan(offset(lotOf(number).closesAt) * 0.45);
    }
  });

  it("plans nothing on a lot nobody wants, and a contest that stops when only the leader could go on", () => {
    expect(bids.filter((bid) => bid.lotNumber === 22)).toEqual([]);
    const only = planBackgroundBids({
      start,
      lots: [{ number: 30, startingBidCents: 1_000, minRaiseCents: 100, currentBidCents: 1_000, highPaddleNumber: 1, closesAt: new Date(start.getTime() + 10 * MINUTE) }],
      paddles: [
        { number: 1, botProfile: { version: 1, budgetCents: 5_000, targets: [{ lotNumber: 30, maxCents: 2_000 }], usesGlim: false, timing: "steady" } },
        { number: 2, botProfile: { version: 1, budgetCents: 5_000, targets: [{ lotNumber: 30, maxCents: 1_200 }], usesGlim: false, timing: "steady" } },
        { number: 3, botProfile: null },
      ],
    });
    // 2 bids $11, 1 answers $12, and 2 cannot pay $13.
    expect(only.map((bid) => bid.paddleNumber)).toEqual([2, 1]);
  });
});
