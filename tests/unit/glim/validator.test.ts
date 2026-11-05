import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isOpenForBids } from "@/server/glim/prompt";
import type { GlimState, PlanIntent } from "@/server/glim/types";
import {
  checkHoldSuggestion,
  checkPlan,
  clampHoldSuggestion,
  clampPlan,
  describeIssuesForModel,
  toGlimActionRecords,
} from "@/server/glim/validator";

import { createGoldenState, lotByNumber } from "../../fixtures/glim/golden-state";

const plan = (budgetDollars: number | null, items: [lot: number, priority: number, capDollars: number | null][]): PlanIntent => ({
  tool: "propose_plan",
  budgetCents: budgetDollars === null ? null : budgetDollars * 100,
  items: items.map(([lotNumber, priority, capDollars]) => ({
    lotNumber,
    priority,
    capCents: capDollars === null ? null : capDollars * 100,
  })),
});

const GOLDEN_INTENT = plan(500, [
  [7, 1, null],
  [12, 2, 120],
]);

const maxima = (allocation: { items: { lot: { number: number }; maxCents: number }[] } | null) =>
  Object.fromEntries((allocation?.items ?? []).map((item) => [item.lot.number, item.maxCents]));

describe("checkPlan", () => {
  it("accepts the golden plan as $380 and $120", () => {
    const check = checkPlan(GOLDEN_INTENT, createGoldenState());
    expect(check.issues).toEqual([]);
    expect(maxima(check.allocation)).toEqual({ 7: 38_000, 12: 12_000 });
  });

  it("rejects a cap below the lot's next minimum bid", () => {
    const check = checkPlan(plan(500, [[7, 1, null], [12, 2, 85]]), createGoldenState());
    expect(check.issues).toEqual([
      {
        reason: "max_below_next_minimum",
        lotNumber: 12,
        lotId: lotByNumber(createGoldenState(), 12).id,
        amountCents: 8_500,
        limitCents: 9_000,
        message: 'Lot 12 "Spa Day": the cap of $85 is below the next minimum bid of $90.',
      },
    ]);
  });

  it("rejects a budget above the bidding power", () => {
    const check = checkPlan(plan(600, [[7, 1, null], [12, 2, 120]]), createGoldenState());
    expect(check.issues.map((issue) => issue.reason)).toEqual(["budget_over_available"]);
    expect(check.issues[0]).toMatchObject({ amountCents: 60_000, limitCents: 50_000 });
    expect(check.issues[0]?.message).toBe(
      "The budget of $600 is above the $500 of bidding power available for this plan.",
    );
  });

  it("rejects closed, unknown and repeated lots", () => {
    const state = createGoldenState();
    lotByNumber(state, 21).status = "closed";
    const check = checkPlan(plan(500, [[7, 1, null], [21, 2, 100], [31, 3, null], [7, 2, 50]]), state);
    expect(check.issues.map((issue) => [issue.reason, issue.lotNumber])).toEqual([
      ["lot_not_open", 21],
      ["unknown_lot", 31],
      ["duplicate_lot", 7],
    ]);
  });

  it("treats a lot past its close time as closed before the engine marks it", () => {
    const state = createGoldenState();
    lotByNumber(state, 3).closesAt = new Date(state.now.getTime() - 1_000);
    expect(checkPlan(plan(500, [[3, 1, null]]), state).issues.map((issue) => issue.reason)).toEqual(["lot_not_open"]);
  });

  it("rejects maximums that add up to more than the plan can use", () => {
    const check = checkPlan(plan(500, [[7, 1, 400], [12, 2, 120]]), createGoldenState());
    expect(check.issues.map((issue) => issue.reason)).toEqual(["total_over_limit"]);
    expect(check.issues[0]?.message).toBe("The maximums add up to $520, above the $500 this plan can use.");
  });

  it("rejects a remainder below the guest's own winning bid", () => {
    const state = createGoldenState();
    lotByNumber(state, 21).guestStatus = "winning";
    state.commitments.push({ lotNumber: 21, source: "winning_bid", cents: 9_500, withoutGlimCents: 9_500 });
    const check = checkPlan(plan(400, [[7, 1, null], [12, 2, 120]]), state);
    expect(check.issues.map((issue) => issue.message)).toEqual([
      'Lot 07 "Chef\'s Table": the budget leaves $280 for it, below the guest\'s winning bid of $320.',
    ]);
  });

  it("needs bidding power before any plan", () => {
    const state = createGoldenState();
    state.holdCents = null;
    const check = checkPlan(GOLDEN_INTENT, state);
    expect(check.issues.map((issue) => issue.reason)).toEqual(["no_hold"]);
    expect(check.allocation).toBeNull();
  });
});

describe("clampPlan", () => {
  it("drops a lot whose cap is below its next minimum and gives priority 1 the rest", () => {
    const clamped = clampPlan(plan(500, [[7, 1, null], [12, 2, 85]]), createGoldenState());
    expect(maxima(clamped.allocation)).toEqual({ 7: 50_000 });
    expect(clamped.adjustments.map((adjustment) => adjustment.message)).toEqual([
      'Left out Lot 12 "Spa Day": the cap of $85 is below the next minimum bid of $90.',
    ]);
  });

  it("lowers a budget above the bidding power to what is available", () => {
    const clamped = clampPlan(plan(600, [[7, 1, null], [12, 2, 120]]), createGoldenState());
    expect(maxima(clamped.allocation)).toEqual({ 7: 38_000, 12: 12_000 });
    expect(clamped.intent.budgetCents).toBe(50_000);
    expect(clamped.adjustments.map((adjustment) => adjustment.reason)).toEqual(["budget_over_available"]);
  });

  it("drops the lowest priority when the lots don't fit together", () => {
    const clamped = clampPlan(plan(500, [[7, 1, 400], [12, 2, 120]]), createGoldenState());
    expect(maxima(clamped.allocation)).toEqual({ 7: 40_000 });
    expect(clamped.adjustments.map((adjustment) => adjustment.message)).toEqual([
      'Left out Lot 12 "Spa Day", the lowest priority: the lots need $520, above the $500 this plan can use.',
    ]);
  });

  it("lowers a cap above what the plan can use instead of dropping the lot", () => {
    const clamped = clampPlan(plan(500, [[12, 1, 800]]), createGoldenState());
    // Jamie's $320 on Lot 07 stays committed outside this plan, leaving $180.
    expect(maxima(clamped.allocation)).toEqual({ 12: 18_000 });
    expect(clamped.adjustments.map((adjustment) => adjustment.message)).toEqual([
      'Lot 12 "Spa Day": the cap of $800 was lowered to $180, all this plan can use.',
      "The budget of $500 was lowered to the $180 of bidding power available.",
    ]);
  });

  it("keeps nothing when no lot fits", () => {
    const state = createGoldenState();
    const clamped = clampPlan(plan(500, [[3, 1, null]]), state);
    expect(clamped.allocation).toBeNull();
    expect(clamped.adjustments.map((adjustment) => adjustment.message)).toEqual([
      'Left out Lot 03 "Cabin Stay": the next minimum bid of $660 is above the $180 this plan can use.',
    ]);
  });

  it("always yields a plan that passes checkPlan and never raises what the guest asked for", () => {
    const base = createGoldenState();
    lotByNumber(base, 21).status = "closed";
    const intentArbitrary = fc.record({
      budget: fc.option(fc.integer({ min: 1, max: 1_200 }), { nil: null }),
      items: fc.array(
        fc.record({
          lot: fc.integer({ min: 1, max: 27 }),
          priority: fc.integer({ min: -1, max: 4 }),
          cap: fc.option(fc.integer({ min: 1, max: 800 }), { nil: null }),
        }),
        { minLength: 1, maxLength: 8 },
      ),
    });

    fc.assert(
      fc.property(intentArbitrary, ({ budget, items }) => {
        const state: GlimState = { ...base, lots: base.lots.map((lot) => ({ ...lot })) };
        const intent = plan(budget, items.map((item) => [item.lot, item.priority, item.cap]));
        const clamped = clampPlan(intent, state);
        if (clamped.allocation === null) return;

        expect(checkPlan(clamped.intent, state).issues).toEqual([]);
        const total = clamped.allocation.items.reduce((sum, item) => sum + item.maxCents, 0);
        if (intent.budgetCents !== null) expect(total).toBeLessThanOrEqual(intent.budgetCents);
        expect(total).toBeLessThanOrEqual(clamped.allocation.availableCents);
        for (const item of clamped.allocation.items) {
          expect(isOpenForBids(item.lot, state.now)).toBe(true);
          expect(item.maxCents).toBeGreaterThanOrEqual(item.floorCents);
          const asked = intent.items.find((candidate) => candidate.lotNumber === item.lot.number);
          if (asked?.capCents != null) expect(item.maxCents).toBeLessThanOrEqual(asked.capCents);
        }
      }),
    );
  });
});

describe("hold suggestions", () => {
  it("accepts a raise inside the event's range", () => {
    expect(checkHoldSuggestion({ amountCents: 100_000, lotNumbers: [3] }, createGoldenState())).toEqual([]);
  });

  it("rejects amounts that are not a raise or are out of range, then clamps them", () => {
    const state = createGoldenState();
    expect(checkHoldSuggestion({ amountCents: 40_000, lotNumbers: [] }, state).map((issue) => issue.reason)).toEqual([
      "hold_not_higher",
    ]);
    expect(checkHoldSuggestion({ amountCents: 150_000, lotNumbers: [] }, state).map((issue) => issue.reason)).toEqual([
      "hold_out_of_range",
    ]);
    expect(clampHoldSuggestion({ amountCents: 150_000, lotNumbers: [] }, state).amountCents).toBe(100_000);
    // Not a raise: the next preset above the $500 hold.
    expect(clampHoldSuggestion({ amountCents: 40_000, lotNumbers: [] }, state).amountCents).toBe(100_000);
  });

  it("offers no raise once bidding power is at the event's maximum", () => {
    const state = createGoldenState();
    state.holdCents = 100_000;
    const clamped = clampHoldSuggestion({ amountCents: 100_000, lotNumbers: [3] }, state);
    expect(clamped.amountCents).toBeNull();
    expect(clamped.adjustments.map((issue) => issue.reason)).toEqual(["hold_at_maximum"]);
  });
});

describe("rejection records", () => {
  it("are glim_actions rows ready to insert", () => {
    const state = createGoldenState();
    const { issues } = checkPlan(plan(500, [[7, 1, null], [12, 2, 85]]), state);
    expect(toGlimActionRecords(issues, { paddleId: state.guest.paddleId, holdCents: state.holdCents })).toEqual([
      {
        paddleId: state.guest.paddleId,
        planId: null,
        lotId: lotByNumber(state, 12).id,
        kind: "proposal_rejected",
        amountCents: 8_500,
        limitCents: 9_000,
        holdCentsAtTime: 50_000,
        decision: "rejected",
        rejectReason: "max_below_next_minimum",
        message: 'Lot 12 "Spa Day": the cap of $85 is below the next minimum bid of $90.',
        chip: "none",
        triggerBidId: null,
      },
    ]);
  });

  it("go back to the model as one plain list", () => {
    const { issues } = checkPlan(plan(600, [[7, 1, null], [12, 2, 85]]), createGoldenState());
    const text = describeIssuesForModel(issues);
    for (const issue of issues) expect(text).toContain(issue.message);
  });
});
