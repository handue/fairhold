import { describe, expect, it } from "vitest";

import { FIXTURE_NOW, riversideFixtureSource } from "@/ui/__fixtures__/riverside";

import { buildCatalogView, getCatalogView, raisedCents, type CatalogQuery } from "./catalog";
import type { LotRecord } from "./types";

const query: CatalogQuery = { slug: "riverside-shelter-gala", paddleNumber: 142, category: null };

async function catalog(overrides: Partial<CatalogQuery> = {}) {
  const view = await getCatalogView({ ...query, ...overrides }, riversideFixtureSource);
  if (!view) throw new Error("the fixture event is missing");
  return view;
}

describe("getCatalogView on the approved fixture", () => {
  it("reproduces 08's bidding power and bid counts", async () => {
    const { viewer } = await catalog();
    expect(viewer).toEqual({
      paddleNumber: 142,
      firstName: "Jamie",
      holdCents: 50_000,
      availableCents: 18_000,
      heldCents: 50_000,
      wonCents: 0,
      winningCount: 1,
      outbidCount: 1,
    });
  });

  it("reproduces the raised total and the lot count", async () => {
    const view = await catalog();
    expect(view.raisedCents).toBe(684_000);
    expect(view.lotCount).toBe(24);
    expect(view.serverNow).toBe(FIXTURE_NOW);
  });

  it("puts the viewer's lots first, then the next to close, as on 08", async () => {
    const { lots } = await catalog();
    expect(lots.slice(0, 8).map((lot) => lot.number)).toEqual([7, 21, 12, 3, 5, 9, 18, 14]);
    expect(lots.slice(8).map((lot) => lot.number)).toEqual([
      1, 2, 4, 6, 8, 10, 11, 13, 15, 16, 17, 19, 20, 22, 23, 24,
    ]);
  });

  it("marks the viewer's relation to each lot", async () => {
    const { lots } = await catalog();
    const byNumber = new Map(lots.map((lot) => [lot.number, lot]));
    expect(byNumber.get(7)).toMatchObject({ viewerStatus: "winning", priceCents: 32_000, bidCount: 12 });
    expect(byNumber.get(21)).toMatchObject({ viewerStatus: "outbid", priceCents: 9_500, offerGlimWatch: false });
    expect(byNumber.get(12)).toMatchObject({ viewerStatus: "none", offerGlimWatch: true });
    expect(byNumber.get(3)).toMatchObject({ viewerStatus: "none", offerGlimWatch: false });
  });

  it("shows the starting bid on a lot nobody has bid on", async () => {
    const { lots } = await catalog();
    expect(lots.find((lot) => lot.number === 22)).toMatchObject({ priceCents: 7_500, bidCount: 0 });
  });

  it("filters by category but keeps the event's totals", async () => {
    const view = await catalog({ category: "dining" });
    expect(view.lots.map((lot) => lot.number)).toEqual([7, 9, 8, 10, 15]);
    expect(view.lotCount).toBe(24);
    expect(view.raisedCents).toBe(684_000);
  });

  it("renders without a viewer when the paddle is unknown", async () => {
    const view = await catalog({ paddleNumber: 999 });
    expect(view.viewer).toBeNull();
    expect(view.lots.every((lot) => lot.viewerStatus === "none")).toBe(true);
  });

  it("returns null for an unknown event", async () => {
    expect(await getCatalogView({ ...query, slug: "nope" }, riversideFixtureSource)).toBeNull();
  });
});

describe("raisedCents", () => {
  const lot = (overrides: Partial<LotRecord>): LotRecord => ({
    id: "lot",
    number: 1,
    category: "art",
    title: "Lot",
    shortTitle: "Lot",
    donorName: "Donor",
    estimatedValueCents: null,
    startingBidCents: 5_000,
    minRaiseCents: 500,
    currentBidCents: null,
    bidCount: 0,
    closesAt: FIXTURE_NOW,
    status: "open",
    highPaddleId: null,
    winningPaddleId: null,
    winningCents: null,
    coverDrawing: null,
    ...overrides,
  });

  it("counts leading bids on open lots and winning amounts on closed lots", () => {
    expect(
      raisedCents([
        lot({ currentBidCents: 9_000 }),
        lot({ status: "closed", currentBidCents: 12_000, winningCents: 12_000 }),
        lot({ status: "closed", currentBidCents: null, winningCents: null }),
        lot({}),
      ]),
    ).toBe(21_000);
  });

  it("places closed lots after open ones", () => {
    const view = buildCatalogView({
      now: FIXTURE_NOW,
      event: {
        id: "e",
        slug: "e",
        name: "Event",
        charityName: "Charity",
        timeZone: "America/Los_Angeles",
        status: "live",
        opensAt: FIXTURE_NOW,
        closesAt: FIXTURE_NOW,
      },
      lots: [lot({ id: "a", number: 1, status: "closed" }), lot({ id: "b", number: 2 })],
      paddle: null,
      viewerLots: [],
      category: null,
    });
    expect(view.lots.map((card) => card.number)).toEqual([2, 1]);
  });
});
