import { describe, expect, it } from "vitest";

import { RIVERSIDE_EVENT, RIVERSIDE_LOTS, templateLot } from "@/server/demo/template";

// The approved intake table (13-web-item-intake): number, category, title, donor, estimated
// value (null = needs a value), starting bid and minimum raise, in dollars.
const APPROVED_LOTS: [number, string, string, string, number | null, number, number][] = [
  [1, "pets", "Name the Next Shelter Puppy", "Riverside Animal Shelter", 0, 100, 25],
  [2, "experiences", "Hot Air Balloon Ride for Two", "Valley Skies Balloons", 500, 250, 25],
  [3, "experiences", "Weekend Cabin Stay", "Pine Hollow Cabins", 600, 250, 20],
  [4, "experiences", "Riverside Theater Season Tickets", "Riverside Theater", 480, 200, 20],
  [5, "art", "Hand-thrown Pottery Set", "Clayworks Studio", 120, 60, 10],
  [6, "experiences", "Sailing Afternoon on the Bay", "Harbor Sailing Club", 400, 200, 20],
  [7, "dining", "Chef’s Table Dinner for Four", "Oak & Ember", 480, 100, 20],
  [8, "dining", "Bakery Box for a Year", "Crumb & Co.", 240, 100, 10],
  [9, "dining", "Private Wine Tasting for Six", "Hillside Cellars", 360, 120, 10],
  [10, "dining", "Wine Club, Six Months", "Hillside Cellars", 300, 120, 10],
  [11, "experiences", "Coffee Roaster Tour", "Northside Roasters", 80, 40, 5],
  [12, "wellness", "Spa Day for Two", "Willow Street Spa", 70, 40, 5],
  [13, "wellness", "Massage Package", "Still Water Massage", 180, 90, 10],
  [14, "art", "Original Watercolor “Harbor at Dusk”", "Mara Lin", 300, 150, 20],
  [15, "dining", "Cooking Class for Four", "Thyme Kitchen", 240, 100, 10],
  [16, "art", "Fine-Art Photo Print", "Juniper Photo", 180, 80, 10],
  [17, "art", "Ceramics Workshop for Two", "Clayworks Studio", 140, 60, 10],
  [18, "experiences", "Family Portrait Session", "Bright Day Studio", 150, 60, 10],
  [19, "wellness", "Yoga, Ten Classes", "Lotus Room", 150, 60, 10],
  [20, "pets", "Dog Grooming Package", "Happy Tails Grooming", 120, 50, 10],
  [21, "pets", "Dog Walking, One Month", "Good Dog Walkers", 100, 40, 5],
  [22, "experiences", "Golf Lesson with a Pro", "Cedar Hills Golf Club", null, 75, 10],
  [23, "art", "Custom Pet Portrait", "Inkwell Pets", null, 80, 10],
  [24, "experiences", "Behind-the-Scenes Shelter Day", "Riverside Animal Shelter", 0, 50, 10],
];

describe("Riverside template lots", () => {
  it("are the 24 approved lots, exactly", () => {
    expect(
      RIVERSIDE_LOTS.map((lot) => [
        lot.number,
        lot.category,
        lot.title,
        lot.donorName,
        lot.estimatedValueCents === null ? null : lot.estimatedValueCents / 100,
        lot.startingBidCents / 100,
        lot.minRaiseCents / 100,
      ]),
    ).toEqual(APPROVED_LOTS);
  });

  it("leave only Golf Lesson and Pet Portrait without a value (13: 22 of 24 ready after Lot 12)", () => {
    const missing = RIVERSIDE_LOTS.filter((lot) => lot.estimatedValueCents === null);
    expect(missing.map((lot) => lot.shortTitle)).toEqual(["Golf Lesson", "Pet Portrait"]);
    expect(RIVERSIDE_LOTS.length - missing.length).toBe(22);
  });

  it("value Lots 01 and 24 at $0, as 13 says", () => {
    expect(RIVERSIDE_LOTS.filter((lot) => lot.estimatedValueCents === 0).map((lot) => lot.number)).toEqual([1, 24]);
  });

  it("use the short titles Glim and the ledger show on the approved screens", () => {
    const shortTitle = (number: number) => templateLot(number).shortTitle;
    expect(shortTitle(7)).toBe("Chef’s Table");
    expect(shortTitle(8)).toBe("Bakery Box");
    expect(shortTitle(10)).toBe("Wine Club");
    expect(shortTitle(11)).toBe("Coffee Roaster Tour");
    expect(shortTitle(12)).toBe("Spa Day");
    expect(shortTitle(21)).toBe("Dog Walking");
    expect(shortTitle(22)).toBe("Golf Lesson");
    expect(new Set(RIVERSIDE_LOTS.map((lot) => lot.shortTitle)).size).toBe(24);
  });

  it("carry Lot 12's approved description and value basis", () => {
    expect(templateLot(12)).toMatchObject({
      description: "Day passes for two: pool, steam room and sauna. Valid through June 2027.",
      valueBasis: "$35 × 2 passes, from the donor’s letter",
    });
  });

  it("count five categories as on 08's tabs", () => {
    const counts = Object.fromEntries(
      ["dining", "experiences", "art", "wellness", "pets"].map((category) => [
        category,
        RIVERSIDE_LOTS.filter((lot) => lot.category === category).length,
      ]),
    );
    expect(counts).toEqual({ dining: 5, experiences: 8, art: 5, wellness: 3, pets: 3 });
  });
});

describe("Riverside event settings", () => {
  it("fit PayPal's 22-character soft descriptor and the approved hold presets", () => {
    expect(RIVERSIDE_EVENT.softDescriptor.length).toBeLessThanOrEqual(22);
    expect(RIVERSIDE_EVENT.holdPresetsCents).toEqual([25_000, 50_000, 100_000]);
    expect(RIVERSIDE_EVENT.holdMinCents).toBe(2_500);
    expect(RIVERSIDE_EVENT.holdMaxCents).toBe(100_000);
  });
});
