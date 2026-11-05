import { describe, expect, it } from "vitest";

import { FIXTURE_NOW, riversideFixtureSource } from "@/ui/__fixtures__/riverside";

import { bidPresetsCents, getLotDetailView, nextMinimumCents } from "./lot";

const MINUTE = 60_000;

async function lotView(lotNumber: number, paddleNumber = 142) {
  const view = await getLotDetailView(
    { slug: "riverside-shelter-gala", lotNumber, paddleNumber },
    riversideFixtureSource,
  );
  if (!view) throw new Error(`lot ${lotNumber} is missing from the fixture`);
  return view;
}

describe("getLotDetailView on the approved fixture", () => {
  it("reproduces 05's bid card", async () => {
    const { lot, viewer } = await lotView(7);
    expect(lot).toMatchObject({
      number: 7,
      category: "dining",
      title: "Chef’s Table Dinner for Four",
      donorName: "Oak & Ember",
      estimatedValueCents: 48_000,
      currentBidCents: 32_000,
      bidCount: 12,
      viewerStatus: "winning",
      nextMinimumCents: 34_000,
      presetCents: [34_000, 36_000, 40_000],
      isFavorite: false,
    });
    expect(lot.closesAt - FIXTURE_NOW).toBe(18 * MINUTE + 42_000);
    expect(viewer?.availableCents).toBe(18_000);
  });

  it("lists the lot's four photos, cover first", async () => {
    const { lot } = await lotView(7);
    expect(lot.photos.map((photo) => photo.drawing)).toEqual(["cloche", "wine-glass", "chef-hat", "menu-card"]);
  });

  it("shows the two latest bids, marking the viewer's", async () => {
    const { history } = await lotView(7);
    expect(history).toEqual([
      { paddleNumber: 142, isViewer: true, amountCents: 32_000, placedAt: FIXTURE_NOW - 130_000 },
      { paddleNumber: 88, isViewer: false, amountCents: 30_000, placedAt: FIXTURE_NOW - 320_000 },
    ]);
  });

  it("knows the viewer was outbid on Dog Walking and hearted Spa Day", async () => {
    expect((await lotView(21)).lot.viewerStatus).toBe("outbid");
    const spa = await lotView(12);
    expect(spa.lot).toMatchObject({ viewerStatus: "none", isFavorite: true });
  });

  it("returns null for a lot the event does not have", async () => {
    expect(
      await getLotDetailView({ slug: "riverside-shelter-gala", lotNumber: 99, paddleNumber: 142 }, riversideFixtureSource),
    ).toBeNull();
  });
});

describe("bid presets", () => {
  it("starts at the starting bid before anyone bids", () => {
    const lot = { highPaddleId: null, currentBidCents: null, startingBidCents: 7_500, minRaiseCents: 1_000 };
    expect(nextMinimumCents(lot)).toBe(7_500);
    expect(bidPresetsCents(lot)).toEqual([7_500, 8_500, 10_500]);
  });

  it("adds the minimum raise to the current bid", () => {
    const lot = { highPaddleId: "paddle-88", currentBidCents: 8_500, startingBidCents: 4_000, minRaiseCents: 500 };
    expect(bidPresetsCents(lot)).toEqual([9_000, 9_500, 10_500]);
  });
});
