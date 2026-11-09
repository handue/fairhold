/**
 * 21's V6 row reads each decision Glim made on its own back against the guest's rules
 * (decisionOutsideRules in src/server/settlement/ledger.ts). These cover the two rules the second
 * review found unchecked: the budget "in all", with R9's exception for a decision that only lowers
 * or drops, and a lot the guest skipped before the decision.
 */
import { describe, expect, it } from "vitest";

import { decisionOutsideRules } from "@/server/settlement/ledger";

const DECIDED_AT = new Date("2026-11-08T04:30:00.000Z");

function mandate(excludedLotIds: string[] = []) {
  return {
    v: 1,
    budgetCents: 50_000,
    lots: [
      { lotId: "chef", lotNumber: 7, role: "plan", source: "words", rank: 1, capCents: 38_000 },
      { lotId: "spa", lotNumber: 12, role: "plan", source: "words", rank: 2, capCents: 12_000 },
      { lotId: "wine", lotNumber: 9, role: "backup", source: "heart", rank: 3, capCents: null },
    ],
    excludedLotIds,
    guestWords: [],
    confirmedAt: "2026-11-08T04:00:00.000Z",
  };
}

type Lot = { lotId: string; lotNumber: number; maxCents: number };

function change(input: {
  before: Lot[];
  after: Lot[];
  excluded?: string[];
  skips?: { lotId: string; at: string }[];
  bids?: { lotId: string; amountCents: number; maxCents: number | null }[];
}) {
  return {
    kind: "autopilot_changed" as const,
    amount_cents: null,
    mandate: mandate(input.excluded),
    // As run.ts stores it: before and after, and no lowerOrDropOnly of its own.
    detail: { before: input.before, after: input.after.map((lot, index) => ({ ...lot, priority: index + 1 })) },
    bids: input.bids ?? [],
    created_at: DECIDED_AT,
    skips: input.skips ?? [],
  };
}

const chef = (maxCents: number): Lot => ({ lotId: "chef", lotNumber: 7, maxCents });
const spa = (maxCents: number): Lot => ({ lotId: "spa", lotNumber: 12, maxCents });
const wine = (maxCents: number): Lot => ({ lotId: "wine", lotNumber: 9, maxCents });

describe("V6's read-back: the budget in all", () => {
  it("passes the golden move: Spa Day and the $380 moved to Wine Tasting, $500 in all", () => {
    expect(decisionOutsideRules(change({ before: [chef(38_000), spa(12_000)], after: [spa(12_000), wine(38_000)] }))).toBe(false);
  });

  it("finds a move that adds up past the budget", () => {
    expect(decisionOutsideRules(change({ before: [chef(38_000), spa(12_000)], after: [spa(12_000), wine(39_000)] }))).toBe(true);
  });

  it("lets a decision that only lowers or drops stand over the budget (R9)", () => {
    // The guest's own plan was over $500 (an earlier, larger budget); Glim only lowered one maximum.
    expect(decisionOutsideRules(change({ before: [chef(38_000), wine(30_000)], after: [chef(38_000), wine(25_000)] }))).toBe(false);
    // Raising any maximum takes the exception away.
    expect(decisionOutsideRules(change({ before: [chef(37_000), wine(30_000)], after: [chef(38_000), wine(25_000)] }))).toBe(true);
  });
});

describe("V6's read-back: a lot the guest skipped", () => {
  it("finds a decision that planned a lot the guest had already skipped", () => {
    const skips = [{ lotId: "wine", at: "2026-11-08T04:20:00.000Z" }];
    expect(decisionOutsideRules(change({ before: [chef(38_000)], after: [spa(12_000), wine(38_000)], excluded: ["wine"], skips }))).toBe(true);
  });

  it("finds a bid on it too", () => {
    const skips = [{ lotId: "wine", at: "2026-11-08T04:20:00.000Z" }];
    const bids = [{ lotId: "wine", amountCents: 22_000, maxCents: 38_000 }];
    expect(decisionOutsideRules(change({ before: [chef(38_000)], after: [spa(12_000)], excluded: ["wine"], skips, bids }))).toBe(true);
  });

  it("does not count a Skip that came after the decision", () => {
    const skips = [{ lotId: "wine", at: "2026-11-08T04:40:00.000Z" }];
    expect(decisionOutsideRules(change({ before: [chef(38_000)], after: [spa(12_000), wine(38_000)], excluded: ["wine"], skips }))).toBe(false);
  });

  it("counts an exclusion with no Skip on record, since nothing says it came later", () => {
    expect(decisionOutsideRules(change({ before: [chef(38_000)], after: [spa(12_000), wine(38_000)], excluded: ["wine"] }))).toBe(true);
  });
});
