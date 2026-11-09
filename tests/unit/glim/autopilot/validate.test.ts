import { describe, expect, it } from "vitest";

import { parseDecision } from "@/server/glim/autopilot/schema";
import type { AutopilotChange, AutopilotDecision, AutopilotDecisionLot } from "@/server/glim/autopilot/types";
import {
  checkDecision,
  inconsistentChange,
  mandateViolations,
  raiseAmount,
  rankingViolations,
  toEngineChange,
} from "@/server/glim/autopilot/validate";

import {
  createClosingPriorityContext,
  createGoldenAutopilotContext,
  createRaiseContext,
  goldenMandate,
  LOT,
  lotIn,
} from "../../../fixtures/glim/autopilot-golden";

const change = (lots: AutopilotDecisionLot[], reason: AutopilotDecision["reason"] = "top_lot_out_of_reach"): AutopilotDecision => ({
  action: "change",
  lots,
  raiseToCents: null,
  reason,
  why: "",
});
const lot = (lotNumber: number, priority: number, maxCents: number | null = null): AutopilotDecisionLot => ({ lotNumber, priority, maxCents });
const GOLDEN = change([lot(12, 2), lot(9, 3)]);

function reasons(decision: AutopilotDecision, context = createGoldenAutopilotContext()): string[] {
  const check = checkDecision(decision, context);
  return check.ok ? [] : check.issues.map((issue) => issue.reason);
}

describe("checkDecision", () => {
  it("accepts the golden move and prices it: Spa Day $120, Wine Tasting $380", () => {
    const check = checkDecision(GOLDEN, createGoldenAutopilotContext());
    expect(check.action).toBe("change");
    if (check.action !== "change") return;
    expect(check.adjusted).toBe(false);
    expect(check.change.after.map((entry) => [entry.lotNumber, entry.maxCents])).toEqual([
      [12, 12_000],
      [9, 38_000],
    ]);
    expect(toEngineChange(check.change)).toEqual({ items: [{ lotId: LOT.wine, maxCents: 38_000 }], removeLotIds: [] });
  });

  it("R0: a reply that is not a valid decision never reaches the rules", () => {
    expect(parseDecision("Move it to the wine tasting.").ok).toBe(false);
    expect(parseDecision(JSON.stringify({ action: "change", lots: [] })).ok).toBe(false);
  });

  it("R1: a lot outside the mandate", () => {
    expect(reasons(change([lot(12, 2), lot(3, 3)]))).toEqual(["outside_mandate"]);
    expect(reasons(change([lot(12, 2), lot(99, 3)]))).toEqual(["outside_mandate"]);
  });

  it("R2: a lot the guest ruled out", () => {
    const context = createGoldenAutopilotContext();
    context.mandate.excludedLotIds = [LOT.wine];
    expect(reasons(GOLDEN, context)).toEqual(["excluded_lot"]);
  });

  it("R3: a lot under the guest's own maximum", () => {
    const context = createGoldenAutopilotContext();
    context.guestControlledLotIds = [LOT.wine];
    expect(reasons(GOLDEN, context)).toEqual(["guest_controlled_lot"]);
  });

  it("R4: a maximum above the guest's cap is set to the cap, and the decision counts as adjusted", () => {
    const check = checkDecision(change([lot(12, 2, 15_000), lot(9, 3)]), createGoldenAutopilotContext());
    expect(check.action).toBe("change");
    if (check.action !== "change") return;
    expect(check.adjusted).toBe(true);
    expect(check.adjustments.map((issue) => issue.reason)).toEqual(["above_guest_cap"]);
    expect(check.change.after.find((entry) => entry.lotNumber === 12)?.maxCents).toBe(12_000);
  });

  it("R5: more than six lots, or a lot closing within 5 s", () => {
    const many = createGoldenAutopilotContext();
    expect(reasons(change([1, 2, 3, 4, 5, 6, 7].map((number) => lot(number, number))), many)).toContain("too_many_lots");
    const closing = createGoldenAutopilotContext();
    lotIn(closing, 9).closesAt = new Date(closing.state.now.getTime() + 4_000);
    expect(reasons(GOLDEN, closing)).toEqual(["closes_too_soon"]);
  });

  it("R6: a contested or recently dropped lot", () => {
    const contested = createGoldenAutopilotContext();
    contested.contestedLotIds = [LOT.wine];
    expect(reasons(GOLDEN, contested)).toEqual(["contested_lot"]);
    const dropped = createGoldenAutopilotContext();
    dropped.recentlyDroppedLotIds = [LOT.wine];
    expect(reasons(GOLDEN, dropped)).toEqual(["recently_dropped"]);
  });

  it("R7: lowering Spa Day for Chef's Table passes; the reverse fails", () => {
    const passes = checkDecision(change([lot(7, 1), lot(12, 2, 9_000)], "priority"), createClosingPriorityContext());
    expect(passes.action).toBe("change");

    // Jamie leads Chef's Table at $320 under Glim's $380, so its maximum could come down to $350.
    const context = createClosingPriorityContext();
    const chef = lotIn(context, 7);
    chef.currentBidCents = 32_000;
    chef.nextMinimumCents = 34_000;
    context.state.commitments = context.state.commitments.map((entry) =>
      entry.lotNumber === 7 ? { ...entry, withoutGlimCents: 32_000 } : entry,
    );
    context.mandate = goldenMandate({
      lots: [
        { lotId: LOT.chef, lotNumber: 7, role: "plan", source: "words", rank: 1, capCents: null },
        { lotId: LOT.spa, lotNumber: 12, role: "plan", source: "words", rank: 2, capCents: null },
      ],
    });
    expect(reasons(change([lot(7, 1, 35_000), lot(12, 2)]), context)).toEqual(["ranking_broken"]);
  });

  it("R7: never moves money from a live lot to a lower-ranked one by dropping it", () => {
    // Dropping Spa Day (rank 2) to give Wine Tasting (rank 4) its money.
    expect(reasons(change([lot(9, 3)]))).toEqual(["ranking_broken"]);
  });

  it("R8: prices within budget(P), and clamps by lowering only", () => {
    // Chef's Table alone: budget(P) is $500 - Spa Day's $90 bid = $410, below its $420 floor.
    expect(reasons(change([lot(7, 1)]))).toEqual(["nothing_fits"]);
    // A guest cap above the budget is lowered to what the plan can use.
    const context = createGoldenAutopilotContext();
    context.mandate.lots = context.mandate.lots.map((entry) => (entry.lotNumber === 12 ? { ...entry, capCents: 60_000 } : entry));
    const check = checkDecision(change([lot(12, 2)]), context);
    expect(check.action).toBe("change");
    if (check.action !== "change") return;
    expect(check.adjusted).toBe(true);
    expect(check.change.after.map((entry) => [entry.lotNumber, entry.maxCents])).toEqual([[12, 50_000]]);
  });

  it("R8: re-prices a clamped plan with the budget of the lots that are left", () => {
    // $1,000 held, $500 named, Spa Day's $90 bid standing: dropping Spa Day may not hand Wine
    // Tasting the whole $500 (that would put $590 on the guest's lots).
    const context = createGoldenAutopilotContext();
    context.state.holdCents = 100_000;
    context.mandate = goldenMandate({
      lots: goldenMandate().lots.map((entry) => (entry.lotNumber === 9 ? { ...entry, rank: 2 } : entry)),
    });
    const check = checkDecision(change([lot(9, 1)]), context);
    expect(check.action).toBe("change");
    if (check.action !== "change") return;
    expect(check.change.after.map((entry) => [entry.lotNumber, entry.maxCents])).toEqual([[9, 41_000]]);
  });

  it("R9: a change that only lowers or drops passes even when the guest's own bids are over the budget", () => {
    const context = createGoldenAutopilotContext();
    const wine = lotIn(context, 9);
    wine.guestStatus = "winning";
    wine.currentBidCents = 45_000;
    wine.nextMinimumCents = 46_000;
    context.state.commitments.push({ lotNumber: 9, source: "winning_bid", cents: 45_000, withoutGlimCents: 45_000 });

    const lower = checkDecision(change([lot(12, 2, 10_000)]), context);
    expect(lower.action).toBe("change");
    if (lower.action !== "change") return;
    expect(lower.change.lowerOrDropOnly).toBe(true);
    expect(lower.change.after.map((entry) => [entry.lotNumber, entry.maxCents])).toEqual([[12, 10_000]]);

    const drop = checkDecision(change([]), context);
    expect(drop.action).toBe("change");
    if (drop.action === "change") expect(drop.change.removeLotIds).toEqual([LOT.spa]);

    expect(reasons(change([lot(12, 2), lot(7, 1)]), context)).toEqual(["nothing_fits"]);
  });

  it("treats a change of no limit, such as a reordering, as keep", () => {
    expect(checkDecision(change([lot(12, 5)]), createGoldenAutopilotContext()).action).toBe("keep");
    expect(checkDecision({ ...GOLDEN, action: "keep" }, createGoldenAutopilotContext()).action).toBe("keep");
  });

  describe("R10: raises", () => {
    const raise = (amountDollars: number | null): AutopilotDecision => ({
      action: "prepare_raise",
      lots: [lot(7, 1), lot(12, 2)],
      raiseToCents: amountDollars === null ? null : amountDollars * 100,
      reason: "raise_needed",
      why: "",
    });

    it("accepts $600 within $540 to $800", () => {
      const check = checkDecision(raise(600), createRaiseContext());
      expect(check.action).toBe("prepare_raise");
      if (check.action !== "prepare_raise") return;
      expect(check.amountCents).toBe(60_000);
      expect(check.adjusted).toBe(false);
      expect(check.plan.bounds).toEqual({ neededCents: 54_000, minCents: 54_000, maxCents: 80_000 });
    });

    it("sets an amount out of range to the code default and counts it as adjusted", () => {
      const check = checkDecision(raise(2_000), createRaiseContext());
      if (check.action !== "prepare_raise") throw new Error("expected a raise");
      expect(check.amountCents).toBe(54_000);
      expect(check.adjusted).toBe(true);
      expect(raiseAmount(30_000, { neededCents: 54_000, minCents: 54_000, maxCents: 120_000 }, [25_000, 50_000, 100_000])).toEqual({
        amountCents: 100_000,
        adjusted: true,
      });
    });

    it("refuses a raise without a budget above the hold, while one is pending, after two, or when the plan fits already", () => {
      expect(reasons(raise(600), createGoldenAutopilotContext())).toEqual(["raise_not_allowed"]);
      const pending = createRaiseContext();
      pending.pendingRaise = { actionId: "a", amountCents: 60_000, createdAt: pending.state.now, approved: false, lots: [] };
      expect(reasons(raise(600), pending)).toEqual(["raise_pending"]);
      const twice = createRaiseContext();
      twice.raisesPrepared = 2;
      expect(reasons(raise(600), twice)).toEqual(["raise_limit_reached"]);
      const fits = createRaiseContext();
      lotIn(fits, 7).nextMinimumCents = 30_000;
      expect(reasons(raise(600), fits)).toEqual(["raise_not_allowed"]);
    });
  });
});

describe("mandateViolations", () => {
  const golden = (): AutopilotChange => {
    const check = checkDecision(GOLDEN, createGoldenAutopilotContext());
    if (check.action !== "change") throw new Error("expected a change");
    return check.change;
  };
  const facts = (closesInMs = 60_000) => ({
    now: new Date("2026-11-08T05:15:00Z"),
    lots: new Map([[LOT.wine, { closesAt: new Date(Date.parse("2026-11-08T05:15:00Z") + closesInMs), open: true }]]),
    guestControlledLotIds: new Set<string>(),
  });

  it("finds nothing wrong with a checked change", () => {
    expect(mandateViolations(golden(), goldenMandate(), facts())).toEqual([]);
  });

  it("finds every mandate rule a raw change breaks", () => {
    const raw = golden();
    raw.after.push({ lotId: LOT.cabin, lotNumber: 3, shortTitle: "Cabin Stay", priority: 9, capCents: null, floorCents: 1, maxCents: 1 });
    raw.after[0] = { ...raw.after[0]!, maxCents: 50_000 };
    const mandate = goldenMandate({ excludedLotIds: [LOT.wine] });
    const found = mandateViolations(raw, mandate, { ...facts(4_000), guestControlledLotIds: new Set([LOT.spa]) });
    expect(found.map((issue) => issue.reason).sort()).toEqual(
      ["above_guest_cap", "closes_too_soon", "excluded_lot", "guest_controlled_lot", "outside_mandate"].sort(),
    );
  });

  it("checks every limit the change writes, even one its plan does not list (review)", () => {
    // `after` keeps Spa Day at its cap; `set` hands the engine more for it, and a lot outside the mandate.
    const raw = golden();
    raw.set = [
      { lotId: LOT.spa, lotNumber: 12, maxCents: 20_000 },
      { lotId: LOT.cabin, lotNumber: 3, maxCents: 10_000 },
    ];
    const lots = new Map([
      [LOT.spa, { closesAt: new Date("2026-11-08T05:23:00Z"), open: true }],
      [LOT.cabin, { closesAt: new Date("2026-11-08T05:30:00Z"), open: true }],
    ]);
    const found = mandateViolations(raw, goldenMandate(), { ...facts(), lots });
    expect(found.map((issue) => [issue.reason, issue.lotNumber])).toEqual([
      ["above_guest_cap", 12],
      ["outside_mandate", 3],
    ]);
  });
});

describe("inconsistentChange", () => {
  const golden = (): AutopilotChange => {
    const check = checkDecision(GOLDEN, createGoldenAutopilotContext());
    if (check.action !== "change") throw new Error("expected a change");
    return check.change;
  };

  it("finds nothing in a checked change", () => {
    expect(inconsistentChange(golden())).toEqual([]);
  });

  it("finds a written limit the plan does not hold, a different maximum, and an ended limit the plan keeps (review)", () => {
    const raw = golden();
    raw.set = [
      { lotId: LOT.cabin, lotNumber: 3, maxCents: 10_000 },
      { lotId: LOT.wine, lotNumber: 9, maxCents: 40_000 },
    ];
    raw.removeLotIds = [LOT.spa];
    expect(inconsistentChange(raw).map((issue) => [issue.reason, issue.lotNumber, issue.amountCents, issue.limitCents])).toEqual([
      ["inconsistent_change", 3, 10_000, null],
      ["inconsistent_change", 9, 40_000, 38_000],
      ["inconsistent_change", 12, null, null],
    ]);
  });
});

describe("rankingViolations", () => {
  it("allows equal ranks to trade", () => {
    const context = createClosingPriorityContext();
    context.mandate.lots = context.mandate.lots.map((entry) => ({ ...entry, rank: 1 }));
    const check = checkDecision(change([lot(7, 1, 37_000), lot(12, 2)]), context);
    if (check.action !== "change") throw new Error("expected a change");
    expect(rankingViolations(check.change, context.mandate)).toEqual([]);
  });
});
