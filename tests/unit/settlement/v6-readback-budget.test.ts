/**
 * 21's V6 row on 12 reads "Glim stayed inside every guest's rules" from decisionOutsideRules
 * (src/server/settlement/ledger.ts), the read-back of each decision Glim made on its own. Besides
 * lots, per-lot caps, limits and a raise, it checks the rule the plan card's block states first:
 * "Never past $500 in all". Found by the Day 3 review, when that rule went unchecked.
 */
import { describe, expect, it } from "vitest";

import { decisionOutsideRules } from "@/server/settlement/ledger";

const mandate = {
  v: 1,
  budgetCents: 50_000,
  lots: [
    { lotId: "chef", lotNumber: 7, role: "plan", source: "words", rank: 1, capCents: 38_000 },
    { lotId: "wine", lotNumber: 9, role: "backup", source: "heart", rank: 2, capCents: null },
  ],
  excludedLotIds: [],
  guestWords: [],
  confirmedAt: "2026-11-08T04:00:00.000Z",
};

function change(after: { lotId: string; lotNumber: number; maxCents: number }[]) {
  return {
    kind: "autopilot_changed" as const,
    amount_cents: null,
    mandate,
    detail: {
      before: [{ lotId: "chef", lotNumber: 7, maxCents: 38_000 }],
      after: after.map((lot, index) => ({ ...lot, shortTitle: lot.lotId, priority: index + 1, capCents: null, floorCents: 0 })),
      lowerOrDropOnly: false,
    },
    bids: [],
  };
}

describe("V6's read-back against the guest's budget", () => {
  it("passes a plan within the guest's $500", () => {
    expect(
      decisionOutsideRules(
        change([
          { lotId: "chef", lotNumber: 7, maxCents: 38_000 },
          { lotId: "wine", lotNumber: 9, maxCents: 12_000 },
        ]),
      ),
    ).toBe(false);
  });

  it("finds a decision that raises the plan to $780 against \"Never past $500 in all\"", () => {
    // Fails today: every lot is one the guest allowed and under its own cap, so it reads as inside.
    expect(
      decisionOutsideRules(
        change([
          { lotId: "chef", lotNumber: 7, maxCents: 38_000 },
          { lotId: "wine", lotNumber: 9, maxCents: 40_000 },
        ]),
      ),
    ).toBe(true);
  });
});
