import { describe, expect, it } from "vitest";

import type { PlanCard } from "@/server/glim/cards";
import {
  autopilotCard,
  changeLines,
  filterWhy,
  planCardAutopilotLines,
  raiseLines,
  rulesLine,
  templateWhy,
  type AppliedFacts,
} from "@/server/glim/autopilot/copy";
import type { AutopilotChange, AutopilotContext, AutopilotDecisionLot, AutopilotTrigger } from "@/server/glim/autopilot/types";
import { checkDecision } from "@/server/glim/autopilot/validate";

import {
  createClosingPriorityContext,
  createGoldenAutopilotContext,
  createRaiseContext,
  createWonTopUpContext,
  GOLDEN_TRIGGER,
  goldenMandate,
  LOT,
  lotIn,
} from "../../../fixtures/glim/autopilot-golden";

const JAMIE = "00000000-0000-4000-8000-000000000142";
const RIVAL = "00000000-0000-4000-8000-000000000088";

function changeFor(context: AutopilotContext, lots: AutopilotDecisionLot[]): AutopilotChange {
  const check = checkDecision({ action: "change", lots, raiseToCents: null, reason: "money_freed", why: "" }, context);
  if (check.action !== "change") throw new Error(`expected a change, got ${check.action}`);
  return check.change;
}

const applied = (fields: Partial<AppliedFacts> = {}): AppliedFacts => ({ paddleId: JAMIE, bids: [], limits: [], lots: [], ...fields });

const goldenApplied = applied({
  bids: [{ id: "bid-1", lotId: LOT.wine, paddleId: JAMIE, amountCents: 22_000, source: "glim" }],
  limits: [{ id: "limit-9", lotId: LOT.wine, maxCents: 38_000, active: true }],
  lots: [{ lotId: LOT.wine, currentBidCents: 22_000, highPaddleId: JAMIE }],
});

describe("autopilot card lines (V2)", () => {
  it("golden: eyebrow, what, chip, rules and Skip", () => {
    const context = createGoldenAutopilotContext();
    const change = changeFor(context, [{ lotNumber: 12, priority: 2, maxCents: null }, { lotNumber: 9, priority: 3, maxCents: null }]);
    const lines = changeLines({ change, context, applied: goldenApplied, trigger: GOLDEN_TRIGGER });
    expect(lines).toMatchObject({
      mainLotId: LOT.wine,
      eyebrow: "9:15 PM · CHEF’S TABLE → WINE TASTING",
      triggerLine: null,
      whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
      chip: { kind: "winning", amountCents: 22_000 },
      priorityCall: false,
    });
    expect(new Set(lines.amountsCents)).toEqual(new Set([38_000, 22_000]));
    const why = "The dinner is past your budget now, so your money goes to the wine tasting you hearted.";
    expect(autopilotCard({ runId: "run-1", actionId: "action-1", context, lines, change, why, whySource: "model" })).toEqual({
      type: "autopilot",
      runId: "run-1",
      actionId: "action-1",
      at: "2026-11-08T05:15:00.000Z",
      eyebrow: "9:15 PM · CHEF’S TABLE → WINE TASTING",
      triggerLine: null,
      whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
      whyLine: why,
      whySource: "model",
      chip: { kind: "winning", amountCents: 22_000 },
      rulesLine: "Your rules: $500 in all · Spa Day up to $120",
      skip: { lotId: LOT.wine, label: "Skip Wine Tasting" },
    });
  });

  it("says when the guest already leads, or another bidder's limit is higher", () => {
    const context = createGoldenAutopilotContext();
    const change = changeFor(context, [{ lotNumber: 12, priority: 2, maxCents: null }, { lotNumber: 9, priority: 3, maxCents: null }]);
    const leading = applied({
      limits: [{ id: "limit-9", lotId: LOT.wine, maxCents: 38_000, active: true }],
      lots: [{ lotId: LOT.wine, currentBidCents: 23_000, highPaddleId: JAMIE }],
    });
    expect(changeLines({ change, context, applied: leading, trigger: GOLDEN_TRIGGER }).whatLine).toBe(
      "I moved the $380 left to Wine Tasting. You’re winning at $230, and I’ll go up to $380.",
    );
    const outbid = applied({
      bids: [
        { id: "bid-1", lotId: LOT.wine, paddleId: JAMIE, amountCents: 22_000, source: "glim" },
        { id: "bid-2", lotId: LOT.wine, paddleId: RIVAL, amountCents: 39_000, source: "guest_max" },
      ],
      limits: [{ id: "limit-9", lotId: LOT.wine, maxCents: 38_000, active: false }],
      lots: [{ lotId: LOT.wine, currentBidCents: 39_000, highPaddleId: RIVAL }],
    });
    const lines = changeLines({ change, context, applied: outbid, trigger: GOLDEN_TRIGGER });
    expect(lines.whatLine).toBe("I moved the $380 left to Wine Tasting, but another bidder’s limit there is higher.");
    expect(lines.chip).toBeNull();
  });

  it("tops up after a win", () => {
    const context = createWonTopUpContext();
    const change = changeFor(context, [{ lotNumber: 9, priority: 4, maxCents: null }]);
    const lines = changeLines({
      change,
      context,
      applied: applied({
        limits: [{ id: "limit-9b", lotId: LOT.wine, maxCents: 41_000, active: true }],
        lots: [{ lotId: LOT.wine, currentBidCents: 22_000, highPaddleId: JAMIE }],
      }),
      trigger: context.triggers[0] ?? null,
    });
    expect(lines.eyebrow).toBe("9:23 PM · SPA DAY → WINE TASTING");
    expect(lines.whatLine).toBe("I added the $30 left to Wine Tasting. It can now go up to $410.");
  });

  it("makes a priority call one minute before the close", () => {
    const context = createClosingPriorityContext();
    const change = changeFor(context, [{ lotNumber: 7, priority: 1, maxCents: null }, { lotNumber: 12, priority: 2, maxCents: 9_000 }]);
    const facts = applied({
      limits: [
        { id: "limit-7b", lotId: LOT.chef, maxCents: 41_000, active: true },
        { id: "limit-12b", lotId: LOT.spa, maxCents: 9_000, active: true },
      ],
      lots: [
        { lotId: LOT.chef, currentBidCents: 38_000, highPaddleId: JAMIE },
        { lotId: LOT.spa, currentBidCents: 9_000, highPaddleId: JAMIE },
      ],
    });
    const lines = changeLines({ change, context, applied: facts, trigger: context.triggers[0] ?? null });
    expect(lines).toMatchObject({
      eyebrow: "9:19 PM · CHEF’S TABLE",
      triggerLine: "1 minute left on Chef’s Table.",
      whatLine: "I lowered Spa Day to $90 so Chef’s Table can go up to $410.",
      priorityCall: true,
    });
    context.state.now = new Date("2026-11-08T05:19:45Z");
    expect(changeLines({ change, context, applied: facts, trigger: context.triggers[0] ?? null }).triggerLine).toBe(
      "Under a minute left on Chef’s Table.",
    );
  });

  it("comes back after a raise", () => {
    const context = createRaiseContext();
    context.state.holdCents = 60_000;
    const trigger: AutopilotTrigger = { kind: "hold_raised", eventLogId: "2001", holdId: "hold-2", amountCents: 60_000 };
    context.triggers = [trigger];
    const change = changeFor(context, [{ lotNumber: 7, priority: 1, maxCents: null }, { lotNumber: 12, priority: 2, maxCents: null }]);
    const lines = changeLines({
      change,
      context,
      applied: applied({
        bids: [{ id: "bid-3", lotId: LOT.chef, paddleId: JAMIE, amountCents: 42_000, source: "glim" }],
        limits: [{ id: "limit-7c", lotId: LOT.chef, maxCents: 48_000, active: true }],
        lots: [{ lotId: LOT.chef, currentBidCents: 42_000, highPaddleId: JAMIE }],
      }),
      trigger,
    });
    expect(lines).toMatchObject({
      eyebrow: "9:15 PM · CHEF’S TABLE",
      triggerLine: "Your $600 is held with PayPal.",
      whatLine: "I’m back on Chef’s Table. I bid $420 for you and will go up to $480.",
    });
  });

  it("stops bidding, and says when the guest's bid stands", () => {
    const context = createGoldenAutopilotContext();
    context.mandate = goldenMandate({
      lots: [...goldenMandate().lots, { lotId: LOT.club, lotNumber: 10, role: "backup", source: "words", rank: 3, capCents: null }],
    });
    const drop: AutopilotChange = {
      after: [],
      before: [{ lotId: LOT.club, lotNumber: 10, maxCents: 30_000 }],
      set: [],
      removeLotIds: [LOT.club],
      lowerOrDropOnly: true,
    };
    const after = (currentBidCents: number, highPaddleId: string) => applied({ lots: [{ lotId: LOT.club, currentBidCents, highPaddleId }] });
    expect(changeLines({ change: drop, context, applied: after(29_000, JAMIE), trigger: null }).whatLine).toBe(
      "I stopped bidding on Wine Club. Your $290 bid stands.",
    );
    expect(changeLines({ change: drop, context, applied: after(31_000, RIVAL), trigger: null }).whatLine).toBe("I stopped bidding on Wine Club.");
  });

  it("names the standing bid the apply read under the lot lock, never the run's earlier read (review)", () => {
    const context = createGoldenAutopilotContext();
    context.mandate = goldenMandate({
      lots: [...goldenMandate().lots, { lotId: LOT.club, lotNumber: 10, role: "backup", source: "words", rank: 3, capCents: null }],
    });
    // The run read Jamie leading Wine Club at $290 before the model call.
    const club = lotIn(context, 10);
    club.guestStatus = "winning";
    club.currentBidCents = 29_000;
    const drop: AutopilotChange = {
      after: [],
      before: [{ lotId: LOT.club, lotNumber: 10, maxCents: 30_000 }],
      set: [],
      removeLotIds: [LOT.club],
      lowerOrDropOnly: true,
    };
    // While the model decided, a rival bid and Glim's limit answered at $300; then the rival passed it.
    const answered = applied({ lots: [{ lotId: LOT.club, currentBidCents: 30_000, highPaddleId: JAMIE }] });
    expect(changeLines({ change: drop, context, applied: answered, trigger: null }).whatLine).toBe(
      "I stopped bidding on Wine Club. Your $300 bid stands.",
    );
    const passed = applied({ lots: [{ lotId: LOT.club, currentBidCents: 32_000, highPaddleId: RIVAL }] });
    expect(changeLines({ change: drop, context, applied: passed, trigger: null }).whatLine).toBe("I stopped bidding on Wine Club.");
    // Without the apply's facts there is no figure to vouch for, so none is stated.
    expect(changeLines({ change: drop, context, applied: applied(), trigger: null }).whatLine).toBe("I stopped bidding on Wine Club.");
  });

  it("writes the template whys by what happened and where the money went", () => {
    const golden = createGoldenAutopilotContext();
    const base = { context: golden, reason: "top_lot_out_of_reach" as const, priorityCall: false, topUp: false, trigger: GOLDEN_TRIGGER };
    expect(templateWhy({ ...base, decidedBy: "rule", mainLotId: LOT.wine })).toBe("It’s a lot you hearted.");
    golden.mandate = goldenMandate({
      lots: goldenMandate().lots.map((entry) => (entry.lotId === LOT.wine ? { ...entry, source: "words", rank: 3 } : entry)),
    });
    expect(templateWhy({ ...base, decidedBy: "rule", mainLotId: LOT.wine })).toBe("It’s the backup you named.");
    expect(templateWhy({ ...base, decidedBy: "model", mainLotId: LOT.chef, priorityCall: true })).toBe("You ranked it higher.");
    expect(
      templateWhy({ ...base, decidedBy: "rule", mainLotId: LOT.wine, topUp: true, trigger: { kind: "lot_won", eventLogId: "1", lotId: LOT.spa, lotNumber: 12, amountCents: 9_000 } }),
    ).toBe("That money was free after your win.");
    expect(templateWhy({ ...base, decidedBy: "pending_raise", mainLotId: LOT.chef })).toBe("You approved the raise for this lot.");
    expect(templateWhy({ ...base, decidedBy: "rule", mainLotId: LOT.chef })).toBe("It’s the lot you ranked first.");
  });

  it("states the guest's rules in the footer", () => {
    const context = createGoldenAutopilotContext();
    expect(rulesLine(context)).toBe("Your rules: $500 in all · Spa Day up to $120");
    context.mandate.budgetCents = null;
    context.mandate.excludedLotIds = [LOT.cabin];
    expect(rulesLine(context)).toBe("Your rules: up to your $500 bidding power · Spa Day up to $120 · never Cabin Stay");
  });
});

describe("prepared raise lines (V3)", () => {
  it("asks for $600 within the $800 named", () => {
    const context = createRaiseContext();
    expect(raiseLines({ context, lotId: LOT.chef, lotNumber: 7, amountCents: 60_000 })).toEqual({
      eyebrow: "9:15 PM · CHEF’S TABLE",
      askLine: "Chef’s Table now needs more than your $500 bidding power. Approve $600 and I’ll keep bidding on it.",
      approveLabel: "Approve $600 in PayPal",
      dismissLabel: "Not now",
      note: "This opens PayPal to approve a $600 hold, within the $800 you named. You pay only for the lots you win.",
      endedLabel: "This offer ended",
      amountsCents: [50_000, 60_000, 80_000],
    });
    expect(
      templateWhy({ context, decidedBy: "rule", reason: "raise_needed", mainLotId: LOT.chef, priorityCall: false, topUp: false, trigger: GOLDEN_TRIGGER }),
    ).toBe("It’s the lot you ranked first.");
  });
});

describe("plan card ON MY OWN block (V1)", () => {
  const card = (fields: Partial<PlanCard> = {}): PlanCard => ({
    type: "plan",
    kind: "new",
    replacesPlanId: null,
    tool: "propose_plan",
    budgetCents: 50_000,
    totalCents: 50_000,
    holdCents: 50_000,
    availableCents: 50_000,
    items: [
      { lotId: LOT.chef, lotNumber: 7, shortTitle: "Chef’s Table", priority: 1, maxCents: 38_000, capCents: null, statusText: "Winning at $320" },
      { lotId: LOT.spa, lotNumber: 12, shortTitle: "Spa Day", priority: 2, maxCents: 12_000, capCents: 12_000, statusText: "Current bid $85" },
    ],
    adjusted: false,
    notes: [],
    backups: [{ lotId: LOT.wine, lotNumber: 9, shortTitle: "Wine Tasting", source: "heart", statusText: "Current bid $210" }],
    excluded: [],
    excludedLotNumbers: [],
    namedBudgetCents: 50_000,
    mandateBudgetCents: 50_000,
    autopilot: true,
    ...fields,
  });

  it("golden: one hearted backup and the rules", () => {
    expect(planCardAutopilotLines(card())).toEqual({
      eyebrow: "ON MY OWN",
      body: "If a lot gets away, I’ll move its money to your other lots or this backup, and tell you why.",
      backups: [{ lotId: LOT.wine, title: "Wine Tasting", sourceLabel: "You hearted it", statusText: "Current bid $210" }],
      rules: "Never past $500 in all, and Spa Day up to $120.",
    });
  });

  it("covers no backups, several, a named one, no budget, exclusions and a budget above the hold", () => {
    expect(planCardAutopilotLines(card({ backups: [] }))?.body).toBe("If a lot gets away, I’ll move its money to your other lots, and tell you why.");
    const two = card({
      backups: [
        { lotId: LOT.wine, lotNumber: 9, shortTitle: "Wine Tasting", source: "words", statusText: "Current bid $210" },
        { lotId: LOT.club, lotNumber: 10, shortTitle: "Wine Club", source: "heart", statusText: "Current bid $290" },
      ],
    });
    expect(planCardAutopilotLines(two)?.body).toBe("If a lot gets away, I’ll move its money to your other lots or these backups, and tell you why.");
    expect(planCardAutopilotLines(two)?.backups[0]?.sourceLabel).toBe("Backup you named");
    expect(
      planCardAutopilotLines(card({ namedBudgetCents: null, mandateBudgetCents: null, items: card().items.map((item) => ({ ...item, capCents: null })) }))
        ?.rules,
    ).toBe("Never past your $500 bidding power.");
    expect(planCardAutopilotLines(card({ excluded: [{ lotId: LOT.cabin, lotNumber: 3, shortTitle: "Cabin Stay" }] }))?.rules).toBe(
      "Never past $500 in all, and Spa Day up to $120. I won’t bid on Cabin Stay.",
    );
    expect(planCardAutopilotLines(card({ namedBudgetCents: 60_000, mandateBudgetCents: 60_000 }))?.rules).toBe(
      "Never past $600 in all, and Spa Day up to $120. If a lot needs more than your $500 bidding power, I’ll ask you to approve more in PayPal, up to the $600 you named.",
    );
  });

  it("states the budget confirming a change card keeps, not the bidding power, when the guest named none (review)", () => {
    // The running plan's B is $500; this change card names no budget and its maxima total $380.
    const change = card({ kind: "change", tool: "propose_change", budgetCents: 38_000, totalCents: 38_000, namedBudgetCents: null, mandateBudgetCents: 38_000 });
    expect(planCardAutopilotLines(change)?.rules).toBe("Never past $380 in all, and Spa Day up to $120.");
  });

  it("is left out when autopilot is off", () => {
    expect(planCardAutopilotLines(card({ autopilot: false }))).toBeNull();
  });
});

describe("filterWhy", () => {
  it("shows a calm sentence with no figures", () => {
    const why = "The dinner is past your budget now, so your money goes to the wine tasting you hearted.";
    expect(filterWhy(`  ${why} `)).toBe(why);
  });

  it("rejects digits, spelled-out amounts, currency, banned words, links, markup and anything long", () => {
    for (const why of [
      "Your 380 goes to the wine tasting.",
      "I moved three hundred to the wine tasting.",
      "I moved twenty to the wine tasting.",
      "Your money goes where it counts, in dollars.",
      "That is a few bucks more.",
      "Moving your $ to the wine tasting.",
      "You will win the wine tasting.",
      "You’ll win the wine tasting.",
      "This is guaranteed to work.",
      "It is definitely the better lot.",
      "It may help with your taxes.",
      "It is fully deductible.",
      "It follows the IRS rules.",
      "See https://example.com for why.",
      "Moving <b>everything</b> to the wine tasting.",
      "Use `max` here.",
      "Great news!",
      "line one\nline two",
      "x".repeat(141),
      "",
    ]) {
      expect(filterWhy(why), why).toBeNull();
    }
  });

  it("rejects other forms of tax and promise wording, also in look-alike letters (review)", () => {
    for (const why of [
      "Winning it is a tax write off for you.",
      "Your bid counts as a writeoff.",
      "It is closer to its market value.",
      "It makes the bid tax-deductible.",
      "This keeps the deduction simple.",
      "We'll win the wine tasting now.",
      "You are going to win the wine tasting.",
      "I promise the wine tasting is yours.",
      "This guarantees your wine tasting.",
      "A win here is ｔａｘａｂｌｅ, so I kept the money on the dinner.",
      "A win here is ta\u200Bxable, so I kept the money on the dinner.",
      "The wine tasting is the lot you hearted！",
      "The wine tasting is next\u2028and closes soon.",
    ]) {
      expect(filterWhy(why), why).toBeNull();
    }
  });

  it("keeps calm whys that only look close", () => {
    for (const why of [
      "Your money now goes to the wine tasting you hearted.",
      "The dinner got away, so I moved your money to the backup you named.",
      "You ranked the spa above the wine tasting, so the spa comes first.",
    ]) {
      expect(filterWhy(why), why).toBe(why);
    }
  });
});
