/**
 * The fixture reproduces the approved screens' figures at the moments they show:
 * 08 and 05 at 8:58:00 PM, 10 and 14 at 9:15:40 PM, 12 at 9:30 PM.
 */
import { describe, expect, it } from "vitest";

import { buildFixtureEventPlan } from "@/server/demo/fixturePlan";
import { commitments } from "@/server/demo/invariant";
import type { EventPlan, PlannedLot } from "@/server/demo/plan";
import { FIXTURE_MOMENTS, pm } from "@/server/demo/storyClock";
import { templateLot } from "@/server/demo/template";

const JAMIE = 142;

const lotOf = (plan: EventPlan, number: number): PlannedLot => {
  const lot = plan.lots.find((candidate) => candidate.number === number);
  if (!lot) throw new Error(`No lot ${number}`);
  return lot;
};

const countdown = (from: Date, to: Date) => {
  const seconds = Math.round((to.getTime() - from.getTime()) / 1_000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};

/** 08's and 14's "raised so far": high bids on open lots plus winning bids on closed ones. */
const raisedCents = (plan: EventPlan) =>
  plan.lots.reduce(
    (sum, lot) => sum + (lot.status === "closed" ? (lot.winningCents ?? 0) : (lot.currentBidCents ?? 0)),
    0,
  );

/** The guest's "left": hold minus leading bids and won lots (10 calls the reserve Glim's room). */
const leftCents = (plan: EventPlan, paddle: number) => {
  const hold = plan.holds.find((row) => row.paddleNumber === paddle)?.amountCents ?? 0;
  const inUse = plan.lots.reduce((sum, lot) => {
    const leads = lot.status === "open" && lot.highPaddleNumber === paddle;
    const won = lot.status === "closed" && lot.winningPaddleNumber === paddle;
    return sum + (leads || won ? (lot.currentBidCents ?? 0) : 0);
  }, 0);
  return hold - inUse;
};

/** The viewer pills of 08: winning where the guest leads, outbid where they bid and do not. */
const viewerStatus = (plan: EventPlan, paddle: number, lot: PlannedLot) => {
  const bid = plan.bids.some((row) => row.lotNumber === lot.number && row.paddleNumber === paddle);
  if (!bid) return "none";
  return lot.highPaddleNumber === paddle ? "winning" : "outbid";
};

describe("fixture at 8:58 PM (08 Lots, 05 Lot 07)", () => {
  const plan = buildFixtureEventPlan({ moment: "catalog" });
  const now = FIXTURE_MOMENTS.catalog;

  it("is live with 24 lots and has raised $6,840", () => {
    expect(plan.event).toMatchObject({ slug: "riverside-shelter-gala", status: "live", isDemo: false });
    expect(plan.lots).toHaveLength(24);
    expect(raisedCents(plan)).toBe(684_000);
    expect(countdown(now, plan.event.closesAt)).toBe("32:00");
  });

  it("shows 08's first eight tiles exactly", () => {
    const tiles = [7, 21, 12, 3, 5, 9, 18, 14].map((number) => {
      const lot = lotOf(plan, number);
      return [number, lot.currentBidCents, lot.bidCount, countdown(now, lot.closesAt), viewerStatus(plan, JAMIE, lot)];
    });
    expect(tiles).toEqual([
      [7, 32_000, 12, "18:42", "winning"],
      [21, 9_500, 6, "15:20", "outbid"],
      [12, 8_500, 4, "26:10", "none"],
      [3, 64_000, 19, "07:55", "none"],
      [5, 15_000, 8, "09:30", "none"],
      [9, 21_000, 10, "12:05", "none"],
      [18, 12_000, 5, "22:15", "none"],
      [14, 27_500, 7, "31:40", "none"],
    ]);
  });

  it("gives Jamie $180 of $500, one winning and one outbid", () => {
    expect(plan.holds.find((hold) => hold.paddleNumber === JAMIE)).toMatchObject({
      amountCents: 50_000,
      authorizedAt: pm("8:41:10"),
    });
    expect(leftCents(plan, JAMIE)).toBe(18_000);
    const statuses = plan.lots.map((lot) => viewerStatus(plan, JAMIE, lot));
    expect(statuses.filter((status) => status === "winning")).toHaveLength(1);
    expect(statuses.filter((status) => status === "outbid")).toHaveLength(1);
  });

  it("offers Let Glim watch on Lot 12: hearted, no bid, no plan", () => {
    expect(plan.favorites).toEqual([{ paddleNumber: JAMIE, lotNumber: 12, createdAt: pm("8:50:00") }]);
    expect(plan.bids.some((bid) => bid.paddleNumber === JAMIE && bid.lotNumber === 12)).toBe(false);
    expect(plan.glimPlans.some((glimPlan) => glimPlan.paddleNumber === JAMIE)).toBe(false);
  });

  it("matches 05: Oak & Ember, $480, presets $340 / $360 / $400, and the latest two bids", () => {
    const lot = lotOf(plan, 7);
    expect([lot.donorName, lot.estimatedValueCents]).toEqual(["Oak & Ember", 48_000]);
    const next = (lot.currentBidCents ?? 0) + lot.minRaiseCents;
    expect([next, next + lot.minRaiseCents, next + 3 * lot.minRaiseCents]).toEqual([34_000, 36_000, 40_000]);
    const latest = plan.bids
      .filter((bid) => bid.lotNumber === 7)
      .slice(-2)
      .reverse()
      .map((bid) => {
        const minutesAgo = Math.floor((now.getTime() - bid.createdAt.getTime()) / 60_000);
        return [bid.paddleNumber, bid.amountCents, minutesAgo];
      });
    expect(latest).toEqual([
      [JAMIE, 32_000, 2],
      [88, 30_000, 5],
    ]);
  });
});

describe("fixture at 9:15:40 PM (10 My paddle, 14 Projector)", () => {
  const plan = buildFixtureEventPlan({ moment: "paddle" });
  const now = FIXTURE_MOMENTS.paddle;

  it("matches 14's header: 24 lots, 86 bidders, $7,720 raised, 14:20 to go", () => {
    expect(plan.lots).toHaveLength(24);
    expect(plan.paddles).toHaveLength(86);
    expect(raisedCents(plan)).toBe(772_000);
    expect(countdown(now, plan.event.closesAt)).toBe("14:20");
  });

  it("matches 14's closing-next board and its 16 lots at 9:30 PM", () => {
    const open = plan.lots
      .filter((lot) => lot.status === "open")
      .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime());
    const board = open.slice(0, 4).map((lot) => [
      lot.number,
      countdown(now, lot.closesAt),
      lot.currentBidCents,
      lot.bidCount,
      lot.highPaddleNumber,
      lot.highBidSource === "glim",
    ]);
    expect(board).toEqual([
      [7, "01:02", 38_000, 14, JAMIE, true],
      [18, "04:35", 15_000, 8, 109, false],
      [12, "08:30", 9_000, 5, JAMIE, true],
      [14, "14:00", 30_000, 8, 163, true],
    ]);
    const rest = open.slice(4);
    expect(rest).toHaveLength(16);
    expect(rest.every((lot) => lot.closesAt.getTime() === pm("9:30").getTime())).toBe(true);
  });

  it("matches 14's Glim bubble: 84 bids for 29 guests", () => {
    const glimBids = plan.bids.filter((bid) => bid.source === "glim");
    expect(glimBids).toHaveLength(84);
    expect(new Set(glimBids.map((bid) => bid.paddleNumber)).size).toBe(29);
  });

  it("matches 10's money panel: $500 held, $470 in winning bids, $30 left", () => {
    expect(leftCents(plan, JAMIE)).toBe(3_000);
    expect(commitments(plan).find((row) => row.paddleNumber === JAMIE)).toEqual({
      paddleNumber: JAMIE,
      committedCents: 50_000,
      holdCents: 50_000,
    });
  });

  it("matches 10's lots: Chef's Table at the $380 limit, Spa Day with $30 of room, Dog Walking sold for $95", () => {
    const items = plan.glimPlanItems.filter((item) => item.paddleNumber === JAMIE);
    expect(items.map((item) => [item.lotNumber, item.maxCents, item.status])).toEqual([
      [7, 38_000, "at_limit"],
      [12, 12_000, "winning"],
    ]);
    const dogWalking = lotOf(plan, 21);
    expect(dogWalking).toMatchObject({
      status: "closed",
      winningPaddleNumber: 117,
      winningCents: 9_500,
      closedAt: pm("9:13:20"),
    });
  });

  it("matches 10's activity feed and 07's event card, newest first", () => {
    const glimPlan = plan.glimPlans.find((row) => row.paddleNumber === JAMIE);
    expect(glimPlan).toMatchObject({ status: "active", budgetCents: 50_000, confirmedAt: pm("9:11:20") });
    const feed = plan.glimActions
      .filter((action) => action.paddleNumber === JAMIE)
      .reverse()
      .map((action) => [action.createdAt, action.lotNumber, action.message, action.chip]);
    expect(feed).toEqual([
      [pm("9:14:06"), 7, "Someone bid $360. I raised to $380, your limit for this lot.", "winning"],
      [pm("9:13:20"), 21, "Bidding closed at $95. You didn’t win, so you won’t be charged.", "closed"],
      [pm("9:12:05"), 12, "I bid $90 for you. I’ll go up to $120.", "winning"],
      [pm("9:11:20"), null, "Chef’s Table up to $380, Spa Day up to $120.", "none"],
    ]);
  });

  it("matches 07's plan card when Glim proposed it: Chef's Table winning at $320, Spa Day at $85", () => {
    const beforePlan = buildFixtureEventPlan({ moment: "catalog" });
    expect(lotOf(beforePlan, 7)).toMatchObject({ currentBidCents: 32_000, highPaddleNumber: JAMIE });
    expect(lotOf(beforePlan, 12).currentBidCents).toBe(8_500);
  });
});

describe("fixture at 9:30 PM (12 Control room, ready to charge)", () => {
  const plan = buildFixtureEventPlan({ moment: "closed" });

  const ledger = plan.paddles
    .map((paddle) => {
      const won = plan.lots.filter((lot) => lot.winningPaddleNumber === paddle.number);
      const held = plan.holds.find((hold) => hold.paddleNumber === paddle.number)?.amountCents ?? 0;
      const toCharge = won.reduce((sum, lot) => sum + (lot.winningCents ?? 0), 0);
      const usedGlim = plan.bids.some((bid) => bid.paddleNumber === paddle.number && bid.source === "glim");
      return {
        paddle: paddle.number,
        bidder: `${paddle.firstName} ${paddle.lastInitial ?? ""}.`,
        lots: won.map((lot) => lot.number),
        glim: usedGlim,
        held,
        toCharge,
        toRelease: held - toCharge,
      };
    })
    .sort((a, b) => b.toCharge - a.toCharge);

  it("has closed every lot: 23 of 24 sold, Golf Lesson with no bids", () => {
    expect(plan.event).toMatchObject({ status: "closed", closedAt: pm("9:30") });
    expect(plan.lots.every((lot) => lot.status === "closed")).toBe(true);
    expect(plan.lots.filter((lot) => lot.winningPaddleNumber !== null)).toHaveLength(23);
    expect(lotOf(plan, 22)).toMatchObject({ bidCount: 0, winningPaddleNumber: null });
  });

  it("totals as on 12: 86 bidders, $43,950 held, $8,160 to charge, $35,790 to release", () => {
    const total = (key: "held" | "toCharge" | "toRelease") => ledger.reduce((sum, row) => sum + row[key], 0);
    expect(ledger).toHaveLength(86);
    expect([total("held"), total("toCharge"), total("toRelease")]).toEqual([4_395_000, 816_000, 3_579_000]);
    expect(ledger.filter((row) => row.toCharge > 0)).toHaveLength(19);
    expect(ledger.filter((row) => row.toCharge === 0)).toHaveLength(67);
  });

  it("lists 12's first page of ten rows exactly", () => {
    const firstPage = ledger
      .slice(0, 10)
      .map((row) => [row.paddle, row.bidder, row.lots, row.glim, row.held, row.toCharge, row.toRelease]);
    expect(firstPage).toEqual([
      [175, "Rosa M.", [1], false, 200_000, 145_000, 55_000],
      [168, "Owen P.", [2], false, 100_000, 78_000, 22_000],
      [104, "Elena R.", [3], false, 100_000, 72_000, 28_000],
      [133, "Marcus L.", [9, 10], true, 100_000, 70_000, 30_000],
      [121, "Ben C.", [4], true, 75_000, 60_000, 15_000],
      [138, "Aisha K.", [6], true, 100_000, 52_000, 48_000],
      [142, "Jamie K.", [7, 12], true, 50_000, 47_000, 3_000],
      [156, "Nora F.", [8, 11], true, 50_000, 42_000, 8_000],
      [117, "Priya N.", [21, 23], false, 50_000, 35_500, 14_500],
      [147, "Leo W.", [24], true, 50_000, 34_000, 16_000],
    ]);
    // Nobody after the first page charges as much as the tenth row, so the sort keeps that page.
    expect(ledger[10]?.toCharge).toBeLessThan(34_000);
  });

  it("matches 12's Glim audit: 96 bids for 31 bidders, 9 of the winners, all within limits", () => {
    const glimBids = plan.bids.filter((bid) => bid.source === "glim");
    expect(glimBids).toHaveLength(96);
    expect(new Set(glimBids.map((bid) => bid.paddleNumber)).size).toBe(31);
    expect(ledger.filter((row) => row.toCharge > 0 && row.glim)).toHaveLength(9);
    const actionOf = new Map(plan.glimActions.map((action) => [action.key, action]));
    for (const bid of glimBids) {
      const action = bid.glimActionKey === null ? undefined : actionOf.get(bid.glimActionKey);
      expect(action?.amountCents).toBe(bid.amountCents);
      expect(bid.amountCents).toBeLessThanOrEqual(action?.limitCents ?? 0);
    }
    expect(plan.glimPlans.every((glimPlan) => glimPlan.status === "ended")).toBe(true);
    expect(plan.bidLimits.every((limit) => !limit.active)).toBe(true);
  });

  it("matches 11 for Jamie: Chef's Table won at 9:17 PM for $380, Spa Day at 9:24 PM for $90", () => {
    // Close times display rounded to the nearest minute: Lot 07 closes at 9:16:42.
    expect(lotOf(plan, 7)).toMatchObject({ winningPaddleNumber: JAMIE, winningCents: 38_000, closedAt: pm("9:16:42") });
    expect(lotOf(plan, 12)).toMatchObject({ winningPaddleNumber: JAMIE, winningCents: 9_000, closedAt: pm("9:24:10") });
    const deductible = (number: number) => {
      const lot = lotOf(plan, number);
      return Math.max(0, (lot.winningCents ?? 0) - (templateLot(number).estimatedValueCents ?? 0));
    };
    expect([deductible(7), deductible(12)]).toEqual([0, 2_000]);
  });
});
