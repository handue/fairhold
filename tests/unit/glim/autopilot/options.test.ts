import { describe, expect, it } from "vitest";

import { computeOptions } from "@/server/glim/autopilot/options";

import {
  createClosingPriorityContext,
  createGoldenAutopilotContext,
  createRaiseContext,
  createWonTopUpContext,
  LOT,
  lotIn,
} from "../../../fixtures/glim/autopilot-golden";

const summary = (context: ReturnType<typeof createGoldenAutopilotContext>) =>
  computeOptions(context).options.map((option) => ({
    kind: option.kind,
    lotNumber: option.lotNumber,
    after: option.check.change.after.map((lot) => [lot.lotNumber, lot.maxCents]),
    raise: option.raise,
  }));

describe("computeOptions", () => {
  it("golden: only Wine Tasting fits; Chef's Table needs $420 against $410", () => {
    const computed = computeOptions(createGoldenAutopilotContext());
    expect(computed.options.map((option) => [option.kind, option.lotNumber, option.lowersLive])).toEqual([["add", 9, false]]);
    expect(computed.options[0]?.check.change.after.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([
      [12, 12_000],
      [9, 38_000],
    ]);
    expect(computed.options[0]?.check.change.set.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([[9, 38_000]]);
    expect(computed.missed).toEqual([
      {
        lotId: LOT.chef,
        lotNumber: 7,
        floorCents: 42_000,
        capBelowFloorCents: null,
        freeCents: 41_000,
        lowered: [{ lotId: LOT.spa, lotNumber: 12, toCents: 9_000, ownBid: true }],
      },
    ]);
  });

  it("offers a raise of $540 to $800 when $800 is named over a $500 hold", () => {
    expect(summary(createRaiseContext())).toEqual([
      {
        kind: "raise",
        lotNumber: 7,
        after: [
          [7, 68_000],
          [12, 12_000],
        ],
        raise: { neededCents: 54_000, minCents: 54_000, maxCents: 80_000 },
      },
    ]);
  });

  it("offers no raise while one is pending, after two, or without a budget above the hold", () => {
    const pending = createRaiseContext();
    pending.pendingRaise = { actionId: "a", amountCents: 60_000, createdAt: pending.state.now, approved: false, lots: [] };
    expect(summary(pending)).toEqual([]);
    const twice = createRaiseContext();
    twice.raisesPrepared = 2;
    expect(summary(twice)).toEqual([]);
    expect(computeOptions(createGoldenAutopilotContext()).options.some((option) => option.kind === "raise")).toBe(false);
  });

  it("tops up Wine Tasting with the $30 left after Spa Day is won at $90", () => {
    expect(summary(createWonTopUpContext())).toEqual([{ kind: "top_up", lotNumber: 9, after: [[9, 41_000]], raise: null }]);
  });

  it("offers a priority call: Spa Day down to its $90 bid so Chef's Table can go to $410", () => {
    const options = computeOptions(createClosingPriorityContext()).options;
    expect(options.map((option) => [option.kind, option.lotNumber, option.lowersLive])).toEqual([["priority", 7, true]]);
    expect(options[0]?.check.change.after.map((lot) => [lot.lotNumber, lot.maxCents])).toEqual([
      [7, 41_000],
      [12, 9_000],
    ]);
  });

  it("leaves out contested and recently dropped lots", () => {
    const contested = createGoldenAutopilotContext();
    contested.contestedLotIds = [LOT.wine];
    expect(computeOptions(contested).options).toEqual([]);
    const dropped = createGoldenAutopilotContext();
    dropped.recentlyDroppedLotIds = [LOT.wine];
    expect(computeOptions(dropped).options).toEqual([]);
  });

  it("leaves out excluded and guest-controlled lots, and lots about to close", () => {
    const excluded = createGoldenAutopilotContext();
    excluded.mandate.excludedLotIds = [LOT.wine];
    expect(computeOptions(excluded).options).toEqual([]);
    const controlled = createGoldenAutopilotContext();
    controlled.guestControlledLotIds = [LOT.wine];
    expect(computeOptions(controlled).options).toEqual([]);
    const closing = createGoldenAutopilotContext();
    lotIn(closing, 9).closesAt = new Date(closing.state.now.getTime() + 4_000);
    expect(computeOptions(closing).options).toEqual([]);
  });

  it("gives an empty list when nothing fits", () => {
    const context = createGoldenAutopilotContext();
    lotIn(context, 9).nextMinimumCents = 40_000;
    expect(computeOptions(context).options).toEqual([]);
  });
});
