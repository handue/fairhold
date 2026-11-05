/**
 * The scripted evening follows the engine's rules at every step, checked here independently of
 * the replay's own guards, and the replay refuses scripts that break them.
 */
import { describe, expect, it } from "vitest";

import { dollars } from "@/server/demo/cents";
import { buildFixtureEventPlan } from "@/server/demo/fixturePlan";
import type { EventPlan } from "@/server/demo/plan";
import { replayAuction, ScriptError, type AuctionScript, type ScriptEvent } from "@/server/demo/replay";
import { LOT_21_STAND_IN, riversideStory } from "@/server/demo/story";
import { DEMO_ANCHOR, STORY_CLOSES_AT, STORY_OPENS_AT, pm } from "@/server/demo/storyClock";

const evening = buildFixtureEventPlan({ moment: "closed" });

describe("the Riverside story", () => {
  it("bids at least the next minimum, in order, only while each lot is open", () => {
    for (const lot of evening.lots) {
      const bids = evening.bids.filter((bid) => bid.lotNumber === lot.number);
      bids.forEach((bid, index) => {
        const previous = bids[index - 1];
        const minimum = previous ? previous.amountCents + lot.minRaiseCents : lot.startingBidCents;
        expect(bid.amountCents, `lot ${lot.number} bid ${index + 1}`).toBeGreaterThanOrEqual(minimum);
        if (previous) expect(bid.createdAt.getTime()).toBeGreaterThan(previous.createdAt.getTime());
        expect(bid.createdAt.getTime()).toBeGreaterThanOrEqual(STORY_OPENS_AT.getTime());
        expect(bid.createdAt.getTime()).toBeLessThan(lot.closesAt.getTime());
      });
      expect(lot.bidCount).toBe(bids.length);
      expect(lot.winningCents).toBe(bids.at(-1)?.amountCents ?? null);
    }
  });

  it("never commits more than a paddle's hold, after any bid of the evening", () => {
    expect(overcommitmentsOverTime(evening)).toEqual([]);
  });

  it("lets Glim answer only by the minimum raise, one second after the rival, within the limit", () => {
    const bidOf = new Map(evening.bids.map((bid) => [bid.key, bid]));
    const raises = evening.glimActions.filter((action) => action.kind === "raise");
    expect(raises.length).toBeGreaterThan(0);
    for (const raise of raises) {
      const answer = evening.bids.find((bid) => bid.glimActionKey === raise.key);
      const rival = raise.triggerBidKey === null ? undefined : bidOf.get(raise.triggerBidKey);
      const lot = evening.lots.find((candidate) => candidate.number === raise.lotNumber);
      if (!answer || !rival || !lot) throw new Error(`Raise ${raise.key} is missing its bids`);
      expect(answer.amountCents).toBe(rival.amountCents + lot.minRaiseCents);
      expect(answer.createdAt.getTime() - rival.createdAt.getTime()).toBe(1_000);
      expect(answer.amountCents).toBeLessThanOrEqual(raise.limitCents ?? 0);
    }
  });

  it("leaves no outbid Glim limit with room unanswered after any bid", () => {
    expect(unansweredLimits(evening)).toEqual([]);
  });

  it("opens a demo with Lot 07 at $300 after 11 bids, so the creator's first bid is $320 and the 12th", () => {
    const opening = replayAuction(riversideStory({ withJamie: false }), DEMO_ANCHOR);
    expect(opening.lots.get(7)).toMatchObject({ currentBidCents: 30_000, bidCount: 11, highPaddle: 88 });
    expect(opening.bids.some((bid) => bid.paddle === 142)).toBe(false);
    const lot21 = opening.bids.filter((bid) => bid.lot === 21);
    expect(lot21.map((bid) => [bid.paddle, bid.amountCents]).slice(-2)).toEqual([
      [LOT_21_STAND_IN, 9_000],
      [117, 9_500],
    ]);
  });
});

describe("replayAuction", () => {
  const script = (events: ScriptEvent[], holdDollars = 500): AuctionScript => ({
    opensAt: pm("7:00"),
    lots: [{ number: 1, startingBidCents: dollars(100), minRaiseCents: dollars(20), closesAt: pm("8:00") }],
    paddles: [1, 2, 3].map((number) => ({ number, holdCents: dollars(holdDollars), holdAuthorizedAt: pm("6:50") })),
    events,
  });
  const bid = (clock: string, paddle: number, amount: number): ScriptEvent => ({
    kind: "bid",
    at: pm(clock),
    lot: 1,
    paddle,
    amount: dollars(amount),
    source: "bot",
  });
  const glimPlan = (clock: string, maxDollars: number): ScriptEvent => ({
    kind: "glim_plan",
    at: pm(clock),
    paddle: 1,
    items: [{ lot: 1, maxCents: dollars(maxDollars) }],
    openingBids: true,
  });

  it("refuses a bid below the next minimum", () => {
    const lowBall = script([bid("7:10", 1, 100), bid("7:11", 2, 110)]);
    expect(() => replayAuction(lowBall, STORY_CLOSES_AT)).toThrow(ScriptError);
  });

  it("refuses a bid at or after the lot's close", () => {
    expect(() => replayAuction(script([bid("8:00", 1, 100)]), STORY_CLOSES_AT)).toThrow(/closed/);
  });

  it("refuses a bid that would commit more than the hold", () => {
    expect(() => replayAuction(script([bid("7:10", 1, 600)]), STORY_CLOSES_AT)).toThrow(/would commit/);
  });

  it("refuses a Glim plan whose limits exceed the hold", () => {
    const plan = glimPlan("7:10", 501);
    expect(() => replayAuction(script([plan]), STORY_CLOSES_AT)).toThrow(/would commit/);
  });

  it("answers rivals by the minimum raise up to the limit, then stops", () => {
    const events = [glimPlan("7:05", 180), bid("7:10", 2, 120), bid("7:20", 3, 160), bid("7:30", 2, 200)];
    const result = replayAuction(script(events), STORY_CLOSES_AT);
    expect(result.bids.map((row) => [row.paddle, row.amountCents / 100, row.source])).toEqual([
      [1, 100, "glim"],
      [2, 120, "bot"],
      [1, 140, "glim"],
      [3, 160, "bot"],
      [1, 180, "glim"],
      [2, 200, "bot"],
    ]);
    expect(result.limits[0]).toMatchObject({ active: false, exhaustedAt: pm("7:30") });
    expect(result.glimActions.map((action) => action.kind)).toEqual([
      "plan_started",
      "bid",
      "raise",
      "raise",
      "limit_reached",
      "lot_lost",
    ]);
    expect(result.lots.get(1)).toMatchObject({ status: "closed", highPaddle: 2, currentBidCents: dollars(200) });
  });
});

/** Walks the evening's rows in time order and reports every bid that left its paddle overcommitted. */
function overcommitmentsOverTime(plan: EventPlan): string[] {
  const hold = new Map(plan.holds.map((row) => [row.paddleNumber, row.amountCents]));
  const leader = new Map<number, { paddle: number; cents: number }>();
  const closesAt = new Map(plan.lots.map((lot) => [lot.number, lot.closesAt.getTime()]));
  const problems: string[] = [];

  const limitActive = (paddle: number, lot: number, at: number) =>
    plan.bidLimits.find(
      (limit) =>
        limit.paddleNumber === paddle &&
        limit.lotNumber === lot &&
        limit.createdAt.getTime() <= at &&
        (limit.endedAt === null || limit.endedAt.getTime() > at),
    );

  const committed = (paddle: number, at: number) => {
    let total = 0;
    for (const lot of plan.lots) {
      const limit = limitActive(paddle, lot.number, at);
      const lead = leader.get(lot.number);
      if (limit && (closesAt.get(lot.number) ?? 0) > at) total += limit.maxCents;
      else if (lead?.paddle === paddle) total += lead.cents;
    }
    return total;
  };

  for (const bid of plan.bids) {
    leader.set(bid.lotNumber, { paddle: bid.paddleNumber, cents: bid.amountCents });
    const at = bid.createdAt.getTime();
    const total = committed(bid.paddleNumber, at);
    if (total > (hold.get(bid.paddleNumber) ?? 0)) {
      problems.push(`paddle ${bid.paddleNumber} at ${bid.createdAt.toISOString()}: ${total}`);
    }
  }
  return problems;
}

/** After each bid, an active limit held by someone else must be unable to cover the next minimum. */
function unansweredLimits(plan: EventPlan): string[] {
  const problems: string[] = [];
  for (const lot of plan.lots) {
    const bids = plan.bids.filter((bid) => bid.lotNumber === lot.number);
    bids.forEach((bid, index) => {
      const next = bids[index + 1];
      // A Glim answer to this bid arrives one second later; judge the state after it.
      if (next && next.source === "glim" && next.createdAt.getTime() - bid.createdAt.getTime() === 1_000) return;
      const at = bid.createdAt.getTime();
      const nextMinimum = bid.amountCents + lot.minRaiseCents;
      for (const limit of plan.bidLimits) {
        const active =
          limit.lotNumber === lot.number &&
          limit.createdAt.getTime() <= at &&
          (limit.endedAt === null || limit.endedAt.getTime() > at);
        if (active && limit.paddleNumber !== bid.paddleNumber && limit.maxCents >= nextMinimum) {
          const at = bid.createdAt.toISOString();
          problems.push(`lot ${lot.number}: paddle ${limit.paddleNumber} left outbid at ${at}`);
        }
      }
    });
  }
  return problems;
}
