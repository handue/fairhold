import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  allocatePlan,
  availableForPlan,
  distributeMaxima,
  minimumMaxCents,
  type PlanLot,
} from "@/server/glim/allocator";
import type { GlimLotState, GlimState } from "@/server/glim/types";

import { createGoldenState, GOLDEN_PLAN, lotByNumber } from "../../fixtures/glim/golden-state";

type Item = { lot: number; priority: number; cap: number | null };

function allocate(state: GlimState, budgetCents: number | null, items: Item[]) {
  if (state.holdCents === null) throw new Error("fixture has no hold");
  return allocatePlan({
    holdCents: state.holdCents,
    budgetCents,
    commitments: state.commitments,
    planLots: items.map((item) => ({ lot: lotByNumber(state, item.lot), priority: item.priority, capCents: item.cap })),
  });
}

const maxima = (allocation: ReturnType<typeof allocate>) =>
  Object.fromEntries(allocation.items.map((item) => [item.lot.number, item.maxCents]));

/** The golden state without Jamie's $320 commitment, for plans that leave Lot 07 out. */
function stateWithNoCommitments(): GlimState {
  const state = createGoldenState();
  state.commitments = [];
  return state;
}

describe("allocatePlan", () => {
  it("turns the golden sentence into Chef's Table $380 and Spa Day $120", () => {
    const state = createGoldenState();
    const allocation = allocate(state, 50_000, [
      { lot: 7, priority: 1, cap: null },
      { lot: 12, priority: 2, cap: 12_000 },
    ]);

    expect(allocation.items.map((item) => [item.lot.shortTitle, item.maxCents])).toEqual(
      GOLDEN_PLAN.map((expected) => [expected.shortTitle, expected.maxCents]),
    );
    expect(allocation.totalCents).toBe(50_000);
    // Jamie's $320 winning bid is on Lot 07, inside the plan, so the whole $500 is available.
    expect(allocation.availableCents).toBe(50_000);
    expect(allocation.limitCents).toBe(50_000);
  });

  it("honors caps first and gives the rest to priority 1", () => {
    const allocation = allocate(stateWithNoCommitments(), 40_000, [
      { lot: 5, priority: 2, cap: 18_000 },
      { lot: 9, priority: 1, cap: null },
    ]);
    expect(maxima(allocation)).toEqual({ 5: 18_000, 9: 22_000 });
  });

  it("gives uncapped lower priorities their next minimum bid", () => {
    const allocation = allocate(createGoldenState(), 50_000, [
      { lot: 7, priority: 1, cap: null },
      { lot: 5, priority: 2, cap: null },
    ]);
    expect(maxima(allocation)).toEqual({ 7: 34_000, 5: 16_000 });
  });

  it("splits the rest evenly in whole dollars among equal top priorities", () => {
    // Floors $160 and $220 leave $101: $50 each, and the odd dollar goes to the lower lot number.
    const allocation = allocate(stateWithNoCommitments(), 48_100, [
      { lot: 9, priority: 1, cap: null },
      { lot: 5, priority: 1, cap: null },
    ]);
    expect(maxima(allocation)).toEqual({ 5: 21_100, 9: 27_000 });
    expect(allocation.totalCents).toBe(48_100);
  });

  it("leaves budget unallocated when every lot has a cap", () => {
    const allocation = allocate(stateWithNoCommitments(), 50_000, [{ lot: 12, priority: 1, cap: 12_000 }]);
    expect(allocation.totalCents).toBe(12_000);
    expect(allocation.limitCents).toBe(50_000);
  });

  it("limits the plan to the hold minus commitments on lots it leaves out", () => {
    const state = createGoldenState();
    // Jamie also leads Dog Walking at $95, outside the plan.
    lotByNumber(state, 21).guestStatus = "winning";
    state.commitments.push({ lotNumber: 21, source: "winning_bid", cents: 9_500, withoutGlimCents: 9_500 });

    const allocation = allocate(state, 50_000, [
      { lot: 7, priority: 1, cap: null },
      { lot: 12, priority: 2, cap: 12_000 },
    ]);
    expect(allocation.availableCents).toBe(40_500);
    expect(allocation.limitCents).toBe(40_500);
    // Below Jamie's own $320 bid: the allocator reports it as is and the validator rejects it.
    expect(maxima(allocation)).toEqual({ 7: 28_500, 12: 12_000 });
  });

  it("frees only the difference when a lot with a Glim limit leaves the plan", () => {
    const commitments = [
      { lotNumber: 7, source: "glim_limit" as const, cents: 38_000, withoutGlimCents: 38_000 },
      { lotNumber: 12, source: "glim_limit" as const, cents: 12_000, withoutGlimCents: 9_000 },
    ];
    // Dropping the spa keeps its $90 winning bid, so $410 is left for the Chef's Table.
    expect(availableForPlan(50_000, commitments, new Set([7]))).toBe(41_000);
  });
});

describe("minimumMaxCents", () => {
  it("is the next minimum bid, or the guest's own winning bid when they lead", () => {
    const state = createGoldenState();
    expect(minimumMaxCents(lotByNumber(state, 12))).toBe(9_000);
    expect(minimumMaxCents(lotByNumber(state, 7))).toBe(32_000);
    expect(minimumMaxCents(lotByNumber(state, 22))).toBe(7_500);
  });
});

describe("distributeMaxima (property)", () => {
  const lotArbitrary = (number: number) =>
    fc.record({ nextDollars: fc.integer({ min: 1, max: 2_000 }), leading: fc.boolean() }).map(
      ({ nextDollars, leading }): GlimLotState => ({
        id: `lot-${number}`,
        number,
        shortTitle: `Lot ${number}`,
        category: "art",
        status: "open",
        closesAt: new Date("2030-01-01T00:00:00Z"),
        currentBidCents: leading ? (nextDollars - 1) * 100 : null,
        bidCount: leading ? 1 : 0,
        nextMinimumCents: nextDollars * 100,
        minRaiseCents: 100,
        guestStatus: leading ? "winning" : "none",
      }),
    );

  const planArbitrary = fc
    .uniqueArray(fc.integer({ min: 1, max: 24 }), { minLength: 1, maxLength: 6 })
    .chain((numbers) =>
      fc.tuple(
        ...numbers.map((number) =>
          fc.record({
            lot: lotArbitrary(number),
            priority: fc.integer({ min: 1, max: 3 }),
            capCents: fc.option(
              fc.integer({ min: 1, max: 3_000 }).map((dollars) => dollars * 100),
              { nil: null },
            ),
          }),
        ),
      ),
    );

  it("spends exactly the limit, never more, when every lot fits at its minimum", () => {
    fc.assert(
      fc.property(planArbitrary, fc.integer({ min: 0, max: 20_000 }), (planLots: PlanLot[], extraDollars) => {
        const feasible = planLots.map((item) =>
          item.capCents !== null && item.capCents < minimumMaxCents(item.lot)
            ? { ...item, capCents: minimumMaxCents(item.lot) }
            : item,
        );
        const needed = feasible.reduce((sum, item) => sum + (item.capCents ?? minimumMaxCents(item.lot)), 0);
        const limit = needed + extraDollars * 100;
        const items = distributeMaxima(feasible, limit);

        const total = items.reduce((sum, item) => sum + item.maxCents, 0);
        expect(total).toBeLessThanOrEqual(limit);
        for (const item of items) {
          expect(item.maxCents).toBeGreaterThanOrEqual(item.floorCents);
          if (item.capCents !== null) expect(item.maxCents).toBe(item.capCents);
        }
        if (feasible.some((item) => item.capCents === null)) expect(total).toBe(limit);
      }),
    );
  });
});
