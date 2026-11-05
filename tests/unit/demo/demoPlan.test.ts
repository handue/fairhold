import { describe, expect, it } from "vitest";

import { buildDemoEventPlan, DEMO_LIFETIME_MS } from "@/server/demo/demoPlan";
import { demoSlug, normalizeFirstName, resolveTimeZone } from "@/server/demo/identity";
import { assertWithinHolds, commitments } from "@/server/demo/invariant";
import type { PlannedLot } from "@/server/demo/plan";
import { STAGGERED_LOTS } from "@/server/demo/schedule";

const NOW = new Date("2026-11-04T21:00:00.000Z");
const MINUTE = 60_000;

const plan = buildDemoEventPlan({
  now: NOW,
  slug: "gala-test",
  timeZone: "America/New_York",
  creator: { firstName: "Alex", lastInitial: null },
});

const lotOf = (number: number): PlannedLot => {
  const lot = plan.lots.find((candidate) => candidate.number === number);
  if (!lot) throw new Error(`No lot ${number}`);
  return lot;
};
const minutesFromNow = (at: Date) => (at.getTime() - NOW.getTime()) / MINUTE;

describe("a demo gala", () => {
  it("has the 24 template lots and 85 simulated paddles with authorized simulated holds", () => {
    expect(plan.lots).toHaveLength(24);
    const simulated = plan.paddles.filter((paddle) => paddle.isSimulated);
    expect(simulated).toHaveLength(85);
    expect(plan.holds).toHaveLength(85);
    const holders = new Set(plan.holds.map((hold) => hold.paddleNumber));
    expect(holders).toEqual(new Set(simulated.map((paddle) => paddle.number)));
    expect(plan.holds.every((hold) => hold.kind === "simulated" && hold.status === "authorized")).toBe(true);
  });

  it("gives the creator paddle 142 with no hold yet", () => {
    const creator = plan.paddles.filter((paddle) => !paddle.isSimulated);
    expect(creator).toEqual([
      { number: 142, firstName: "Alex", lastInitial: null, isSimulated: false, botProfile: null, createdAt: NOW },
    ]);
    expect(plan.holds.some((hold) => hold.paddleNumber === 142)).toBe(false);
    expect(plan.bids.some((bid) => bid.paddleNumber === 142)).toBe(false);
  });

  it("is a private demo that expires in 6 hours, in the creator's time zone", () => {
    expect(plan.event).toMatchObject({
      slug: "gala-test",
      isDemo: true,
      status: "live",
      timeZone: "America/New_York",
      joinUrl: "/e/gala-test",
      templateKey: "riverside-shelter-gala",
    });
    expect(plan.event.demoExpiresAt?.getTime()).toBe(NOW.getTime() + DEMO_LIFETIME_MS);
    expect(DEMO_LIFETIME_MS).toBe(6 * 60 * MINUTE);
  });

  it("runs 25 minutes: 8 lots close between +10 and +20, the rest at +25", () => {
    expect(minutesFromNow(plan.event.closesAt)).toBe(25);
    const staggered = plan.lots.filter((lot) => minutesFromNow(lot.closesAt) < 25);
    expect(staggered.map((lot) => lot.number).sort((a, b) => a - b)).toEqual([...STAGGERED_LOTS].sort((a, b) => a - b));
    for (const lot of staggered) {
      expect(minutesFromNow(lot.closesAt)).toBeGreaterThanOrEqual(10);
      expect(minutesFromNow(lot.closesAt)).toBeLessThanOrEqual(20);
    }
    const order = [...staggered].sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime()).map((lot) => lot.number);
    expect(order).toEqual([...STAGGERED_LOTS]);
    expect(plan.lots.every((lot) => lot.status === "open")).toBe(true);
  });

  it("opens on 08's catalog with Lot 07 one bid short: $300 after 11 bids", () => {
    const tiles = [7, 21, 12, 3, 5, 9, 18, 14].map((number) => {
      const lot = lotOf(number);
      return [number, lot.currentBidCents, lot.bidCount];
    });
    expect(tiles).toEqual([
      [7, 30_000, 11],
      [21, 9_500, 6],
      [12, 8_500, 4],
      [3, 64_000, 19],
      [5, 15_000, 8],
      [9, 21_000, 10],
      [18, 12_000, 5],
      [14, 27_500, 7],
    ]);
    const lot7 = lotOf(7);
    expect((lot7.currentBidCents ?? 0) + lot7.minRaiseCents).toBe(32_000);
    // 08's $6,840 includes Jamie's $320 on Lot 07; without it the room has raised $6,820.
    expect(plan.lots.reduce((sum, lot) => sum + (lot.currentBidCents ?? 0), 0)).toBe(682_000);
  });

  it("seeds bids in the past, in order per lot, and none from Glim", () => {
    expect(plan.bids).toHaveLength(231);
    expect(plan.bids.every((bid) => bid.source === "bot" && bid.createdAt < NOW)).toBe(true);
    expect(plan.lots.every((lot) => lot.highBidSource === null || lot.highBidSource === "bot")).toBe(true);
    for (const lot of plan.lots) {
      const times = plan.bids.filter((bid) => bid.lotNumber === lot.number).map((bid) => bid.createdAt.getTime());
      expect(times).toEqual([...times].sort((a, b) => a - b));
      expect(times.length).toBe(lot.bidCount);
    }
    const glimRows = [plan.glimPlans, plan.glimPlanItems, plan.bidLimits, plan.glimActions, plan.favorites];
    expect(glimRows.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0]);
  });

  it("never commits more than any paddle's hold", () => {
    expect(() => assertWithinHolds(plan)).not.toThrow();
    for (const row of commitments(plan)) expect(row.committedCents).toBeLessThanOrEqual(row.holdCents);
  });

  it("gives every simulated guest a bot profile within its hold", () => {
    for (const paddle of plan.paddles.filter((candidate) => candidate.isSimulated)) {
      const profile = paddle.botProfile;
      if (!profile) throw new Error(`Paddle ${paddle.number} has no profile`);
      const hold = plan.holds.find((row) => row.paddleNumber === paddle.number)?.amountCents;
      expect(profile.budgetCents).toBe(hold);
      const wanted = profile.targets.reduce((sum, target) => sum + target.maxCents, 0);
      expect(wanted).toBeLessThanOrEqual(profile.budgetCents);
    }
  });

  it("scripts the golden path's rivals: 088 goes to $360 on Chef's Table, nobody past $85 on Spa Day", () => {
    const targetsOn = (lot: number) =>
      plan.paddles.flatMap((paddle) =>
        (paddle.botProfile?.targets ?? [])
          .filter((target) => target.lotNumber === lot)
          .map((target) => [paddle.number, target.maxCents]),
      );
    expect(targetsOn(7).find(([paddle]) => paddle === 88)).toEqual([88, 36_000]);
    expect(Math.max(...targetsOn(7).map(([, max]) => max ?? 0))).toBe(36_000);
    expect(Math.max(...targetsOn(12).map(([, max]) => max ?? 0))).toBe(8_500);
  });

  it("copies the approved drawings as lot photos, cover first", () => {
    const lot7 = plan.lotPhotos.filter((photo) => photo.lotNumber === 7);
    expect(lot7.map((photo) => [photo.position, photo.isCover])).toEqual([
      [0, true],
      [1, false],
      [2, false],
      [3, false],
    ]);
    const lotsWithPhotos = new Set(plan.lotPhotos.map((photo) => photo.lotNumber));
    expect(plan.lotPhotos.filter((photo) => photo.isCover)).toHaveLength(lotsWithPhotos.size);
  });
});

describe("demo identity", () => {
  it("makes unguessable, URL-safe slugs", () => {
    const slugs = Array.from({ length: 200 }, () => demoSlug());
    expect(new Set(slugs).size).toBe(200);
    for (const slug of slugs) expect(slug).toMatch(/^gala-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(demoSlug(() => new Uint8Array(10))).toBe("gala-0000000000000000");
  });

  it("keeps a real IANA time zone and falls back otherwise", () => {
    expect(resolveTimeZone("Europe/Berlin", "America/Los_Angeles")).toBe("Europe/Berlin");
    expect(resolveTimeZone("Mars/Olympus_Mons", "America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(resolveTimeZone(undefined, "America/Los_Angeles")).toBe("America/Los_Angeles");
  });

  it("requires a first name of at most 40 characters", () => {
    expect(normalizeFirstName("  Mary   Ann ")).toBe("Mary Ann");
    expect(() => normalizeFirstName("   ")).toThrow(RangeError);
    expect(() => normalizeFirstName("x".repeat(41))).toThrow(RangeError);
  });
});
