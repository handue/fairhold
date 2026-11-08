import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HOLD_MAX_CENTS,
  exampleWinCents,
  highestHoldCents,
  holdAmountIssue,
  holdAmountMessage,
  holdRangeIssue,
  lowestHoldCents,
  resolveHoldLimits,
} from "@/server/holds/rules";
import { holdSwapRefusal } from "@/server/paypal/hold-store";

const LIMITS = { presetsCents: [250_00, 500_00, 1_000_00], minCents: 25_00, maxCents: 1_000_00 };
const NO_STANDING = { currentHoldCents: null, committedCents: 0 };

describe("holdRangeIssue", () => {
  it("accepts whole dollars from the minimum to the maximum", () => {
    expect(holdRangeIssue(25_00, LIMITS)).toBeNull();
    expect(holdRangeIssue(750_00, LIMITS)).toBeNull();
    expect(holdRangeIssue(1_000_00, LIMITS)).toBeNull();
  });

  it.each([[750_50], [1], [0], [-100], [1.5], [Number.NaN], [Number.MAX_VALUE]])("refuses %s as not whole dollars", (cents) => {
    expect(holdRangeIssue(cents, LIMITS)).toEqual({ reason: "not_whole_dollars" });
  });

  it("names the limit it refused", () => {
    expect(holdRangeIssue(24_00, LIMITS)).toEqual({ reason: "below_minimum", minCents: 25_00 });
    expect(holdRangeIssue(1_001_00, LIMITS)).toEqual({ reason: "above_maximum", maxCents: 1_000_00 });
  });
});

describe("holdAmountIssue", () => {
  it("refuses a raise that is not above the hold in place, equal included", () => {
    const standing = { currentHoldCents: 500_00, committedCents: 320_00 };
    expect(holdAmountIssue(500_00, LIMITS, standing)).toEqual({ reason: "not_a_raise", currentHoldCents: 500_00 });
    expect(holdAmountIssue(250_00, LIMITS, standing)).toEqual({ reason: "not_a_raise", currentHoldCents: 500_00 });
    expect(holdAmountIssue(501_00, LIMITS, standing)).toBeNull();
  });

  it("refuses a hold too small for the paddle's commitments", () => {
    const standing = { currentHoldCents: null, committedCents: 320_00 };
    expect(holdAmountIssue(250_00, LIMITS, standing)).toEqual({ reason: "below_commitments", committedCents: 320_00 });
    expect(holdAmountIssue(320_00, LIMITS, standing)).toBeNull();
  });

  it("says each refusal in a sentence with its figure", () => {
    expect(holdAmountMessage({ reason: "not_whole_dollars" })).toBe("Enter a whole dollar amount.");
    expect(holdAmountMessage({ reason: "below_minimum", minCents: 25_00 })).toBe("The least you can hold is $25.");
    expect(holdAmountMessage({ reason: "above_maximum", maxCents: 1_000_00 })).toBe("The most you can hold is $1,000.");
    expect(holdAmountMessage({ reason: "not_a_raise", currentHoldCents: 500_00 })).toBe(
      "You already hold $500. Choose more than that.",
    );
    expect(holdAmountMessage({ reason: "below_commitments", committedCents: 320_00 })).toBe(
      "Your bids already need $320 of bidding power. Choose at least that.",
    );
  });

  it("agrees with the swap's own rule on every amount the range allows", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000 }),
        fc.option(fc.integer({ min: 1, max: 2_000 })),
        fc.integer({ min: 0, max: 200_000 }),
        (dollars, currentDollars, committedCents) => {
          const amountCents = dollars * 100;
          const currentHoldCents = currentDollars === null ? null : currentDollars * 100;
          const limits = { minCents: 100, maxCents: 2_000_00 };
          const issue = holdAmountIssue(amountCents, limits, { currentHoldCents, committedCents });
          const refusal = holdSwapRefusal({ eventStatus: "live", amountCents, currentHoldCents, committedCents });
          // Whatever this window would be refused at approval, it is refused here, and the reverse.
          expect(issue).toEqual(refusal);
        },
      ),
    );
  });
});

describe("the page's floor and ceiling", () => {
  it("starts at the event's minimum for a first hold", () => {
    expect(lowestHoldCents(LIMITS, NO_STANDING)).toBe(25_00);
    expect(highestHoldCents(LIMITS)).toBe(1_000_00);
  });

  it("starts a dollar above the hold in place", () => {
    expect(lowestHoldCents(LIMITS, { currentHoldCents: 500_00, committedCents: 320_00 })).toBe(501_00);
  });

  it("rounds a commitment up to whole dollars", () => {
    expect(lowestHoldCents(LIMITS, { currentHoldCents: null, committedCents: 320_50 })).toBe(321_00);
  });

  it("leaves no room at the maximum", () => {
    const standing = { currentHoldCents: 1_000_00, committedCents: 0 };
    expect(lowestHoldCents(LIMITS, standing)).toBeGreaterThan(highestHoldCents(LIMITS));
  });

  it("is always an amount the rules accept, when one exists", () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 1, max: 1_000 })),
        fc.integer({ min: 0, max: 150_000 }),
        (currentDollars, committedCents) => {
          const standing = { currentHoldCents: currentDollars === null ? null : currentDollars * 100, committedCents };
          const lowest = lowestHoldCents(LIMITS, standing);
          if (lowest > highestHoldCents(LIMITS)) return;
          expect(holdAmountIssue(lowest, LIMITS, standing)).toBeNull();
          expect(holdAmountIssue(lowest - 100, LIMITS, standing)).not.toBeNull();
        },
      ),
    );
  });
});

describe("resolveHoldLimits", () => {
  it("fills in what the event leaves open, with the plan's $1,000 cap", () => {
    expect(resolveHoldLimits({ presetsCents: null, minCents: null, maxCents: null })).toEqual({
      presetsCents: [],
      minCents: 100,
      maxCents: DEFAULT_HOLD_MAX_CENTS,
    });
    expect(DEFAULT_HOLD_MAX_CENTS).toBe(1_000_00);
  });
});

describe("exampleWinCents", () => {
  it.each([
    [500_00, 320_00],
    [250_00, 160_00],
    [1_000_00, 640_00],
    [750_00, 480_00],
    [25_00, 16_00],
  ])("gives a hold of %i cents an example win of %i", (hold, win) => {
    expect(exampleWinCents(hold)).toBe(win);
  });

  it("always fits inside the hold, in whole dollars", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), (dollars) => {
        const win = exampleWinCents(dollars * 100);
        expect(win % 100).toBe(0);
        expect(win).toBeLessThanOrEqual(dollars * 100);
      }),
    );
  });
});
