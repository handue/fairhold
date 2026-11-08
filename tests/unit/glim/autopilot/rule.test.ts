import { describe, expect, it } from "vitest";

import { computeOptions } from "@/server/glim/autopilot/options";
import { ruleDecision } from "@/server/glim/autopilot/rule";
import { checkDecision } from "@/server/glim/autopilot/validate";

import {
  createClosingPriorityContext,
  createGoldenAutopilotContext,
  createRaiseContext,
  createWonTopUpContext,
  goldenMandate,
  LOT,
  lotIn,
} from "../../../fixtures/glim/autopilot-golden";

function decide(context: ReturnType<typeof createGoldenAutopilotContext>) {
  const decision = ruleDecision(context, computeOptions(context).options);
  const check = checkDecision(decision, context);
  return { decision, check };
}

describe("ruleDecision", () => {
  it("golden: moves the money to Wine Tasting, up to $380", () => {
    const { decision, check } = decide(createGoldenAutopilotContext());
    expect(decision).toMatchObject({ action: "change", reason: "top_lot_out_of_reach" });
    expect(check.action).toBe("change");
    if (check.action !== "change") return;
    expect(check.change.set.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([[9, 38_000]]);
  });

  it("walks the guest's order: a named backup before a hearted one", () => {
    const context = createGoldenAutopilotContext();
    context.mandate = goldenMandate({
      lots: [...goldenMandate().lots, { lotId: LOT.club, lotNumber: 10, role: "backup", source: "words", rank: 3, capCents: null }],
    });
    const { check } = decide(context);
    if (check.action !== "change") throw new Error("expected a change");
    expect(check.change.set.map((lot) => lot.lotNumber)).toEqual([10]);
  });

  it("tops up after a win", () => {
    const { decision, check } = decide(createWonTopUpContext());
    expect(decision.reason).toBe("money_freed");
    if (check.action !== "change") throw new Error("expected a change");
    expect(check.change.set.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([[9, 41_000]]);
  });

  it("never makes a priority call or prepares a raise: it keeps", () => {
    expect(decide(createClosingPriorityContext()).decision.action).toBe("keep");
    expect(decide(createRaiseContext()).decision.action).toBe("keep");
  });

  it("never takes an add that lowers a live lot; it tops up instead", () => {
    // After the golden move with no budget named and $1,000 held: adding Chef's Table back would
    // lower Wine Tasting to its floor, so the rule tops Wine Tasting up instead.
    const context = createGoldenAutopilotContext();
    context.mandate = goldenMandate({ budgetCents: null });
    context.state.holdCents = 100_000;
    const wine = lotIn(context, 9);
    wine.guestStatus = "winning";
    wine.currentBidCents = 22_000;
    wine.nextMinimumCents = 23_000;
    context.limits.push({ id: "limit-9", lotId: LOT.wine, lotNumber: 9, owner: "glim", maxCents: 38_000, createdAt: context.state.now });
    context.state.commitments.push({ lotNumber: 9, source: "glim_limit", cents: 38_000, withoutGlimCents: 22_000 });
    const options = computeOptions(context).options;
    expect(options.find((option) => option.kind === "add" && option.lotNumber === 7)?.lowersLive).toBe(true);
    const { check } = decide(context);
    if (check.action !== "change") throw new Error("expected a change");
    expect(check.change.set.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([[9, 88_000]]);
    expect(check.change.removeLotIds).toEqual([]);
  });
});
