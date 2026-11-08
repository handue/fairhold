/** The director's timing and ceilings on a controllable clock, with no database. */
import { describe, expect, it } from "vitest";

import {
  chooseRival,
  delayWithin,
  destinationLotNumbers,
  directorCeilingCents,
  overLimitAllowed,
  RIVAL_OUTBID_DELAY,
  RIVAL_OVER_LIMIT_GAP,
  RIVAL_UNDER_LIMIT_DELAY,
  rivalOutbidAt,
  rivalOverLimitAt,
  rivalUnderLimitAt,
  type RivalCandidate,
} from "@/server/director/rules";
import { seededRandom, unitFromKey } from "@/server/director/seed";

const start = new Date("2026-11-08T20:00:00Z");
const SECOND = 1_000;
const at = (minutes: number, seconds = 0) => new Date(start.getTime() + (minutes * 60 + seconds) * SECOND);

describe("the rivals' delays", () => {
  const paddles = Array.from({ length: 400 }, (_, index) => index + 1);

  it("bids Glim's priority-1 lot 20 to 40 seconds after Start bidding, leaving room for the tick", () => {
    for (const paddle of paddles) {
      const delay = rivalUnderLimitAt(start, paddle).getTime() - start.getTime();
      expect(delay).toBeGreaterThanOrEqual(20 * SECOND);
      expect(delay).toBeLessThanOrEqual(38 * SECOND);
    }
  });

  it("outbids the guest's second manual lot 15 to 30 seconds after it, leaving room for the tick", () => {
    for (const paddle of paddles) {
      const delay = rivalOutbidAt(start, paddle).getTime() - start.getTime();
      expect(delay).toBeGreaterThanOrEqual(15 * SECOND);
      expect(delay).toBeLessThanOrEqual(28 * SECOND);
    }
  });

  it("is the same every time for one paddle and seed, and spreads across paddles", () => {
    expect(rivalUnderLimitAt(start, 142)).toEqual(rivalUnderLimitAt(start, 142));
    expect(rivalUnderLimitAt(start, 142, "other seed")).not.toEqual(rivalUnderLimitAt(start, 142));
    const delays = new Set(paddles.map((paddle) => delayWithin(RIVAL_UNDER_LIMIT_DELAY, `under:${paddle}`)));
    expect(delays.size).toBeGreaterThan(300);
    const spread = [...delays];
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(15 * SECOND);
  });

  it("uses the whole of a range too short to leave room for the tick, and never goes below it", () => {
    expect(delayWithin({ minMs: 1_000, maxMs: 1_500 }, "x")).toBe(1_000);
    expect(RIVAL_OUTBID_DELAY.minMs).toBe(15 * SECOND);
    expect(RIVAL_OVER_LIMIT_GAP.minMs).toBeGreaterThan(30 * SECOND);
  });
});

describe("the rival who passes Glim's limit", () => {
  const wineCloses = at(12);

  it("comes a beat after the first rival when there is time", () => {
    const underLimitAt = at(3);
    const overAt = rivalOverLimitAt({ underLimitAt, destinationClosesAt: [wineCloses], paddleNumber: 142 });
    const gap = overAt.getTime() - underLimitAt.getTime();
    expect(gap).toBeGreaterThanOrEqual(RIVAL_OVER_LIMIT_GAP.minMs);
    expect(gap).toBeLessThanOrEqual(RIVAL_OVER_LIMIT_GAP.maxMs);
  });

  it("moves up to stay before +10:30 when the first rival comes late", () => {
    const underLimitAt = at(10);
    const overAt = rivalOverLimitAt({ underLimitAt, destinationClosesAt: [wineCloses], paddleNumber: 142 });
    expect(overAt.getTime()).toBeLessThan(at(10, 30).getTime());
    expect(overAt.getTime()).toBeGreaterThan(underLimitAt.getTime());
    expect(overLimitAllowed([{ status: "open", closesAt: wineCloses }], overAt)).toBe(true);
  });

  it("still follows the first rival when +10:30 has passed; overLimitAllowed then stops it", () => {
    const underLimitAt = at(10, 40);
    const overAt = rivalOverLimitAt({ underLimitAt, destinationClosesAt: [wineCloses], paddleNumber: 142 });
    expect(overAt.getTime()).toBeGreaterThan(underLimitAt.getTime());
    expect(overLimitAllowed([{ status: "open", closesAt: wineCloses }], overAt)).toBe(false);
  });

  it("fires only while the destination has at least 90 seconds left: +10:30 on Wine Tasting", () => {
    const open = [{ status: "open", closesAt: wineCloses }];
    expect(overLimitAllowed(open, at(3))).toBe(true);
    expect(overLimitAllowed(open, at(10, 29))).toBe(true);
    expect(overLimitAllowed(open, at(10, 30))).toBe(true);
    expect(overLimitAllowed(open, at(10, 31))).toBe(false);
    expect(overLimitAllowed(open, at(13))).toBe(false);
    expect(overLimitAllowed([{ status: "closed", closesAt: wineCloses }], at(3))).toBe(false);
    expect(overLimitAllowed([], at(3))).toBe(false);
  });

  it("looks at the guest's backups, so a named Wine Club keeps the beat after Wine Tasting", () => {
    expect(destinationLotNumbers(null)).toEqual([9]);
    expect(destinationLotNumbers([{ lotNumber: 7, role: "plan", rank: 1 }, { lotNumber: 12, role: "plan", rank: 2 }])).toEqual([9]);
    expect(
      destinationLotNumbers([
        { lotNumber: 7, role: "plan", rank: 1 },
        { lotNumber: 9, role: "backup", rank: 4 },
        { lotNumber: 10, role: "backup", rank: 3 },
      ]),
    ).toEqual([10, 9]);

    const lots = [
      { status: "closed", closesAt: wineCloses },
      { status: "open", closesAt: at(25) },
    ];
    expect(overLimitAllowed(lots, at(13))).toBe(true);
    expect(
      rivalOverLimitAt({ underLimitAt: at(13), destinationClosesAt: [wineCloses, at(25)], paddleNumber: 142 }).getTime(),
    ).toBeGreaterThan(at(13, 40).getTime() - 1);
  });
});

describe("directorCeilingCents", () => {
  it("is $370 on Wine Tasting and no limit elsewhere", () => {
    expect(directorCeilingCents(9)).toBe(37_000);
    expect(directorCeilingCents(7)).toBeGreaterThan(1_000_000);
    expect(directorCeilingCents(10)).toBeGreaterThan(1_000_000);
  });
});

describe("chooseRival", () => {
  const candidate = (number: number, availableCents: number, targets: RivalCandidate["targets"] = []): RivalCandidate => ({
    id: `p${number}`,
    number,
    availableCents,
    targets,
  });
  const harold = candidate(88, 50_000, [{ lotNumber: 7, maxCents: 36_000 }]);
  const bea = candidate(70, 100_000);
  const earlier = candidate(149, 50_000, [{ lotNumber: 7, maxCents: 12_000 }]);

  it("prefers the guest the story has wanting this lot at this price", () => {
    expect(chooseRival([bea, earlier, harold], { lotNumber: 7, amountCents: 36_000, leadingPaddleId: "guest" })?.number).toBe(88);
  });

  it("then anyone who wanted the lot at all, then anyone with room", () => {
    expect(chooseRival([bea, earlier, harold], { lotNumber: 7, amountCents: 40_000, leadingPaddleId: "guest" })?.number).toBe(88);
    expect(chooseRival([bea, earlier], { lotNumber: 7, amountCents: 40_000, leadingPaddleId: "guest" })?.number).toBe(149);
    expect(chooseRival([bea], { lotNumber: 7, amountCents: 40_000, leadingPaddleId: "guest" })?.number).toBe(70);
  });

  it("never picks a guest without room on their hold, or the lot's leader", () => {
    expect(chooseRival([harold], { lotNumber: 7, amountCents: 60_000, leadingPaddleId: "guest" })).toBeNull();
    expect(chooseRival([harold], { lotNumber: 7, amountCents: 36_000, leadingPaddleId: "p88" })).toBeNull();
    expect(chooseRival([], { lotNumber: 7, amountCents: 100, leadingPaddleId: null })).toBeNull();
  });
});

describe("the seed", () => {
  it("gives the same numbers for the same key, in [0, 1)", () => {
    expect(unitFromKey("a")).toBe(unitFromKey("a"));
    expect(unitFromKey("a")).not.toBe(unitFromKey("b"));
    const first = seededRandom("x");
    const second = seededRandom("x");
    for (let index = 0; index < 1_000; index += 1) {
      const value = first();
      expect(value).toBe(second());
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
