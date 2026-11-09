/**
 * Review finding (Nov 7, autopilot): filterWhy is the only code that stands between the model's
 * free-text "why" and the guest's card (docs/planning/glim-autopilot.md §6.3). The brand rules say
 * Fairhold never writes anything that reads as tax advice and never promises an outcome, but the
 * filter matches whole words only, so close variants pass:
 *   - "taxable" (the word-boundary after "tax" fails on "taxable"), "fair market value" (FMV spelled
 *     out) and "write-off" read as tax advice;
 *   - "I'll win" and "guaranteeing" promise an outcome ("will win" and "guarantee[sd]?" need
 *     exactly those forms).
 * Each line below has no digits, no amounts and no currency, so nothing else in filterWhy stops it.
 */
import { describe, expect, it } from "vitest";

import { filterWhy } from "@/server/glim/autopilot/copy";

describe("filterWhy keeps tax and promise wording off the card (review)", () => {
  it.each([
    "A win here is taxable, so I kept your money on the dinner you ranked first.",
    "The wine tasting is closest to its fair market value, so your money goes there.",
    "Part of this bid is a write-off for you, so I moved your money to the wine tasting.",
  ])("rejects tax wording: %s", (why) => {
    expect(filterWhy(why)).toBeNull();
  });

  it.each([
    "I'll win the wine tasting for you now that the dinner got away.",
    "I am guaranteeing you the wine tasting you hearted.",
  ])("rejects a promised outcome: %s", (why) => {
    expect(filterWhy(why)).toBeNull();
  });

  it("still shows a calm why without those words", () => {
    expect(filterWhy("The dinner is past your budget now, so your money goes to the wine tasting you hearted.")).not.toBeNull();
  });
});
