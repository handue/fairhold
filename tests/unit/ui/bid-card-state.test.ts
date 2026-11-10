import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { commitmentCents } from "@/server/engine/rules";
import { ApiClientError } from "@/ui/api";
import type { LotDetail, LotRecord, PaddleRecord, ViewerLotRecord } from "@/server/queries/types";
import {
  bidAction,
  bidCardPhase,
  maxFieldDigits,
  maxFieldText,
  powerOnLot,
  presetsLabel,
  priceLabel,
  raiseToCoverCents,
  refusalOf,
  soldToPaddleNumber,
  trustLine,
  wonPaymentLine,
  wonTileLine,
  type PowerOnLot,
} from "@/ui/lot/bid-card-state";

const JAMIE = "paddle-142";

function lot(number: number, change: Partial<LotRecord> = {}): LotRecord {
  return {
    id: `lot-${number}`,
    number,
    category: "dining",
    title: `Lot ${number}`,
    shortTitle: `Lot ${number}`,
    donorName: "Donor",
    estimatedValueCents: null,
    startingBidCents: 100_00,
    minRaiseCents: 20_00,
    currentBidCents: null,
    bidCount: 0,
    closesAt: 0,
    status: "open",
    highPaddleId: null,
    winningPaddleId: null,
    winningCents: null,
    coverDrawing: null,
    ...change,
  };
}

const paddle = (holdCents: number | null): PaddleRecord => ({ id: JAMIE, number: 142, firstName: "Jamie", holdCents });
const relation = (lotId: string, limitCents: number | null): ViewerLotRecord => ({
  lotId,
  hasBid: true,
  isFavorite: false,
  inGlimPlan: false,
  limitCents,
});

/** Jamie as design/19 draws state 3: $320 leading on Lot 07, so $180 of $500 is left anywhere else. */
const JAMIE_LOTS = [lot(7, { currentBidCents: 320_00, highPaddleId: JAMIE, bidCount: 12 }), lot(3, { currentBidCents: 500_00, highPaddleId: "paddle-088", bidCount: 16 })];

type CardLot = Pick<LotDetail, "viewerStatus" | "currentBidCents" | "nextMinimumCents">;
const winning: CardLot = { viewerStatus: "winning", currentBidCents: 320_00, nextMinimumCents: 340_00 };
const open: CardLot = { viewerStatus: "none", currentBidCents: 500_00, nextMinimumCents: 520_00 };

describe("powerOnLot", () => {
  it("leaves $180 of $500 for a lot Jamie isn't on, with $320 leading elsewhere (state 3)", () => {
    expect(powerOnLot({ lots: JAMIE_LOTS, paddle: paddle(500_00), viewerLots: [] }, "lot-3")).toEqual({
      holdCents: 500_00,
      availableCents: 180_00,
      limitHereCents: null,
    });
  });

  it("doesn't count the lot's own leading bid against it", () => {
    expect(powerOnLot({ lots: JAMIE_LOTS, paddle: paddle(500_00), viewerLots: [] }, "lot-7").availableCents).toBe(500_00);
  });

  it("reserves a limit elsewhere at its max, as the engine does, and reports the one here", () => {
    const viewerLots = [relation("lot-7", 380_00), relation("lot-3", 450_00)];
    expect(powerOnLot({ lots: JAMIE_LOTS, paddle: paddle(500_00), viewerLots }, "lot-3")).toEqual({
      holdCents: 500_00,
      availableCents: 120_00,
      limitHereCents: 450_00,
    });
  });

  it("counts a won lot, and nothing for a lost one", () => {
    const lots = [
      lot(1, { status: "closed", currentBidCents: 90_00, winningPaddleId: JAMIE, winningCents: 90_00 }),
      lot(2, { status: "closed", currentBidCents: 95_00, winningPaddleId: "paddle-117", winningCents: 95_00 }),
      lot(3),
    ];
    expect(powerOnLot({ lots, paddle: paddle(500_00), viewerLots: [relation("lot-2", null)] }, "lot-3").availableCents).toBe(
      410_00,
    );
  });

  it("has nothing without a hold, and never goes below zero", () => {
    expect(powerOnLot({ lots: JAMIE_LOTS, paddle: paddle(null), viewerLots: [] }, "lot-3")).toMatchObject({
      holdCents: null,
      availableCents: 0,
    });
    expect(powerOnLot({ lots: JAMIE_LOTS, paddle: paddle(200_00), viewerLots: [] }, "lot-3").availableCents).toBe(0);
  });

  it("matches the engine's commitments on any set of lots", () => {
    const lotArb = fc.record({
      closed: fc.boolean(),
      cents: fc.integer({ min: 1, max: 2_000 }).map((dollars) => dollars * 100),
      mine: fc.boolean(),
      limit: fc.option(fc.integer({ min: 1, max: 2_000 }).map((dollars) => dollars * 100), { nil: null }),
    });
    fc.assert(
      fc.property(fc.array(lotArb, { minLength: 1, maxLength: 8 }), fc.integer({ min: 0, max: 5_000 }), (specs, holdDollars) => {
        const lots = specs.map((spec, index) =>
          lot(index + 1, {
            status: spec.closed ? "closed" : "open",
            currentBidCents: spec.cents,
            highPaddleId: spec.mine ? JAMIE : "rival",
            winningPaddleId: spec.closed ? (spec.mine ? JAMIE : "rival") : null,
            winningCents: spec.closed ? spec.cents : null,
          }),
        );
        const viewerLots = specs.map((spec, index) => relation(`lot-${index + 1}`, spec.closed ? null : spec.limit));
        const target = lots[0];
        if (!target) return;
        const elsewhere = lots
          .slice(1)
          .reduce((sum, other, index) => sum + commitmentCents(other, JAMIE, viewerLots[index + 1]?.limitCents ?? null), 0);
        const power = powerOnLot({ lots, paddle: paddle(holdDollars * 100), viewerLots }, target.id);
        expect(power.availableCents).toBe(Math.max(0, holdDollars * 100 - elsewhere));
      }),
    );
  });
});

describe("bidAction", () => {
  const power = (change: Partial<PowerOnLot> = {}): PowerOnLot => ({
    holdCents: 500_00,
    availableCents: 500_00,
    limitHereCents: null,
    ...change,
  });

  it("places the bid on screen, as Bid again when outbid (states 1, 4, 5)", () => {
    expect(bidAction({ lot: winning, power: power(), amountCents: 340_00, max: null, refusal: null })).toEqual({
      kind: "place",
      amountCents: 340_00,
      label: "Place bid",
    });
    const outbid = { ...open, viewerStatus: "outbid" as const };
    const roomy = power({ holdCents: 1_000_00, availableCents: 1_000_00 });
    expect(bidAction({ lot: outbid, power: roomy, amountCents: 520_00, max: null, refusal: null })).toMatchObject({
      label: "Bid again",
    });
  });

  it("sends a guest with no hold to 09 first (state 6)", () => {
    expect(bidAction({ lot: open, power: power({ holdCents: null, availableCents: 0 }), amountCents: 520_00, max: null, refusal: null })).toEqual({
      kind: "set_power",
    });
  });

  it("offers a raise for a bid over what is left, with the figures to show (state 3)", () => {
    expect(bidAction({ lot: open, power: power({ availableCents: 180_00 }), amountCents: 520_00, max: null, refusal: null })).toEqual({
      kind: "raise",
      subject: "bid",
      neededCents: 520_00,
      availableCents: 180_00,
      holdCents: 500_00,
      raiseToCents: 840_00,
    });
  });

  it("counts a limit already on the lot, as the engine does", () => {
    const action = bidAction({ lot: open, power: power({ availableCents: 560_00, limitHereCents: 600_00 }), amountCents: 520_00, max: null, refusal: null });
    expect(action).toMatchObject({ kind: "raise", neededCents: 600_00 });
  });

  it("takes a max of at least the next minimum, or Jamie's own leading bid (state 2)", () => {
    expect(bidAction({ lot: winning, power: power(), amountCents: 340_00, max: { maxCents: 380_00 }, refusal: null })).toEqual({
      kind: "set_max",
      maxCents: 380_00,
      minimumCents: 320_00,
      tooLow: false,
    });
    expect(bidAction({ lot: open, power: power(), amountCents: 520_00, max: { maxCents: 510_00 }, refusal: null })).toMatchObject({
      tooLow: true,
      minimumCents: 520_00,
    });
    expect(bidAction({ lot: open, power: power(), amountCents: 520_00, max: { maxCents: null }, refusal: null })).toMatchObject({
      kind: "set_max",
      maxCents: null,
      tooLow: false,
    });
  });

  it("offers a raise for a max over what is left", () => {
    expect(bidAction({ lot: winning, power: power({ availableCents: 500_00 }), amountCents: 340_00, max: { maxCents: 600_00 }, refusal: null })).toMatchObject({
      kind: "raise",
      subject: "max",
      neededCents: 600_00,
    });
  });

  it("believes the server's refusal over its own sums", () => {
    const refusal = { kind: "over_bidding_power" as const, requiredCents: 340_00, availableCents: 300_00, holdCents: 500_00 };
    expect(bidAction({ lot: winning, power: power(), amountCents: 340_00, max: null, refusal })).toMatchObject({
      kind: "raise",
      neededCents: 340_00,
      availableCents: 300_00,
      raiseToCents: 540_00,
    });
    expect(bidAction({ lot: winning, power: power(), amountCents: 340_00, max: null, refusal: { kind: "no_hold" } })).toEqual({
      kind: "set_power",
    });
    expect(
      bidAction({ lot: winning, power: power(), amountCents: 340_00, max: null, refusal: { kind: "message", message: "x" } }),
    ).toMatchObject({ kind: "place" });
  });
});

describe("raiseToCoverCents", () => {
  it("is the hold plus the shortfall, rounded up to whole dollars", () => {
    expect(raiseToCoverCents({ holdCents: 500_00, availableCents: 180_00, limitHereCents: null }, 520_00)).toBe(840_00);
    expect(raiseToCoverCents({ holdCents: 500_00, availableCents: 180_00, limitHereCents: null }, 180_50)).toBe(501_00);
    expect(raiseToCoverCents({ holdCents: null, availableCents: 0, limitHereCents: null }, 520_00)).toBeNull();
  });
});

describe("the card's phase and words", () => {
  const detail = (change: Partial<LotDetail>) =>
    ({ status: "open", viewerStatus: "none", currentBidCents: 320_00, ...change }) as Pick<LotDetail, "status" | "viewerStatus" | "currentBidCents">;

  it("opens, closes and says how a lot ended (states 7 to 9)", () => {
    expect(bidCardPhase(detail({}), "live")).toBe("open");
    expect(bidCardPhase(detail({}), "scheduled")).toBe("opens_soon");
    expect(bidCardPhase(detail({}), "draft")).toBe("opens_soon");
    expect(bidCardPhase(detail({ status: "closed", viewerStatus: "won" }), "closed")).toBe("won");
    expect(bidCardPhase(detail({ status: "closed", viewerStatus: "lost" }), "closed")).toBe("sold");
    expect(bidCardPhase(detail({ status: "closed", viewerStatus: "none" }), "live")).toBe("sold");
    expect(bidCardPhase(detail({ status: "closed", currentBidCents: null }), "closed")).toBe("unsold");
  });

  it("labels the price and the presets as drawn", () => {
    expect(priceLabel("open", 320_00)).toBe("Current bid");
    expect(priceLabel("open", null)).toBe("Starting bid");
    expect(priceLabel("opens_soon", null)).toBe("Starting bid");
    expect(priceLabel("sold", 400_00)).toBe("Final bid");
    expect(priceLabel("won", 380_00)).toBe("Final bid");
    expect(presetsLabel(null)).toBe("Your bid");
    expect(presetsLabel(320_00)).toBe("Raise to");
  });

  it("says what holds the bids in each state", () => {
    expect(trustLine("open", "place", "live")).toBe("Held with PayPal. You’re only charged if you win.");
    expect(trustLine("open", "set_power", "live")).toBe("Bids are held with PayPal. You’re only charged if you win.");
    expect(trustLine("open", "raise", "live")).toBe("You’ll approve another hold in a PayPal window.");
    expect(trustLine("opens_soon", null, "scheduled")).toBe("Bids are held with PayPal. You’re only charged if you win.");
    expect(trustLine("sold", null, "live")).toBe("You’re only charged for lots you win.");
    expect(trustLine("won", null, "live")).toBe("The rest of your hold is released at the same time.");
    expect(trustLine("won", null, "settled")).toBe("The rest of your hold was released.");
  });

  it("names the payment's time only while it is still ahead", () => {
    expect(wonPaymentLine("live", "9:30 PM")).toBe("You’ll pay with PayPal at 9:30 PM");
    expect(wonPaymentLine("settling", "9:30 PM")).toBe("You’ll pay with PayPal shortly");
    expect(wonPaymentLine("settled", "9:30 PM")).toBe("Paid with PayPal");
    expect(wonTileLine("live", "9:30 PM")).toBe("You’ll pay at 9:30 PM");
    expect(wonTileLine("closed", "9:30 PM")).toBe("You’ll pay shortly");
    expect(wonTileLine("settled", "9:30 PM")).toBe("Paid");
  });

  it("uses no word the brand rules forbid", () => {
    const words = [
      ...(["open", "opens_soon", "won", "sold", "unsold"] as const).flatMap((phase) =>
        (["place", "set_power", "raise", "set_max", null] as const).map((action) => trustLine(phase, action, "live")),
      ),
      ...(["live", "closed", "settled"] as const).flatMap((status) => [wonPaymentLine(status, "9:30 PM"), wonTileLine(status, "9:30 PM")]),
    ].join(" ");
    expect(words).not.toMatch(/FMV|IRS|guarantee|tax|fair market/i);
  });
});

describe("soldToPaddleNumber", () => {
  const history = [
    { paddleNumber: 88, amountCents: 400_00 },
    { paddleNumber: 142, amountCents: 380_00 },
  ];

  it("is the newest bid's paddle once the lot closed on it", () => {
    expect(soldToPaddleNumber({ status: "closed", currentBidCents: 400_00 }, history)).toBe(88);
  });

  it("is unknown while open, with no bids, or when the history doesn't reach the final bid", () => {
    expect(soldToPaddleNumber({ status: "open", currentBidCents: 400_00 }, history)).toBeNull();
    expect(soldToPaddleNumber({ status: "closed", currentBidCents: null }, [])).toBeNull();
    expect(soldToPaddleNumber({ status: "closed", currentBidCents: 420_00 }, history)).toBeNull();
  });
});

describe("Max…'s field", () => {
  it("keeps digits only and shows them as dollars", () => {
    expect(maxFieldDigits("$1,200")).toBe("1200");
    expect(maxFieldDigits("0380")).toBe("380");
    expect(maxFieldDigits("12.50")).toBe("1250");
    expect(maxFieldDigits("abc")).toBe("");
    expect(maxFieldDigits("123456789")).toBe("1234567");
    expect(maxFieldText("1200")).toBe("$1,200");
    expect(maxFieldText("380")).toBe("$380");
    expect(maxFieldText("")).toBe("");
  });
});

describe("refusalOf", () => {
  it("turns the engine's refusals into the states that show them", () => {
    expect(refusalOf(new ApiClientError(409, "no_hold", "Set your bidding power before you bid."))).toEqual({ kind: "no_hold" });
    const details = { requiredCents: 520_00, availableCents: 180_00, holdCents: 500_00, shortfallCents: 340_00 };
    expect(refusalOf(new ApiClientError(409, "over_bidding_power", "This needs $520.", details))).toEqual({
      kind: "over_bidding_power",
      requiredCents: 520_00,
      availableCents: 180_00,
      holdCents: 500_00,
    });
  });

  it("keeps the server's sentence for the rest, and a plain one for anything unreadable", () => {
    expect(refusalOf(new ApiClientError(409, "below_minimum", "The next minimum bid is $360."))).toEqual({
      kind: "message",
      message: "The next minimum bid is $360.",
    });
    expect(refusalOf(new ApiClientError(409, "over_bidding_power", "This needs $520.", null))).toMatchObject({ kind: "message" });
    expect(refusalOf(new Error("boom"))).toEqual({ kind: "message", message: "Something went wrong. Please try again." });
  });
});
