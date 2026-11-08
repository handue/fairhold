/**
 * The Riverside Shelter Gala: the seeded template that every demo gala is cloned from and that
 * the approved screens were drawn with. The lot table is the approved intake table (13); the
 * opening bids live in story.ts, and README.md lists every figure that could not be matched.
 */
import { dollars } from "./cents";
import { STORY_TIME_ZONE } from "./storyClock";

export const TEMPLATE_KEY = "riverside-shelter-gala";

/** The fixture event's slug, and the template every demo copies. */
export const FIXTURE_SLUG = "riverside-shelter-gala";

/** Every demo creator gets this paddle, as Jamie does on the approved screens. */
export const CREATOR_PADDLE_NUMBER = 142;

export const LOT_CATEGORIES = ["dining", "experiences", "art", "wellness", "pets"] as const;
export type LotCategory = (typeof LOT_CATEGORIES)[number];

export interface TemplateLot {
  number: number;
  category: LotCategory;
  title: string;
  /** Glim's and the ledger's name for the lot, e.g. "Chef’s Table". */
  shortTitle: string;
  donorName: string;
  /** null is "Needs a value" on 13: the organizer has not set one yet. */
  estimatedValueCents: number | null;
  valueBasis: string | null;
  description: string | null;
  startingBidCents: number;
  minRaiseCents: number;
}

export const RIVERSIDE_EVENT = {
  name: "Riverside Shelter Gala",
  charityName: "Riverside Animal Shelter",
  charityEin: "12-3456789",
  charityIs501c3: true,
  timeZone: STORY_TIME_ZONE,
  currency: "USD",
  // 11 shows "PAYPAL *RIVERSIDEGALA" on the statement; PayPal allows at most 22 characters.
  softDescriptor: "RIVERSIDEGALA",
  holdPresetsCents: [dollars(250), dollars(500), dollars(1_000)],
  // Sheet A's "Other…" amount: whole dollars, $25 to $1,000 (the plan's cap on demo holds).
  holdMinCents: dollars(25),
  holdMaxCents: dollars(1_000),
  pickupNote: "Show this receipt at the front desk by 10 PM.",
} as const;

type LotRow = [
  number: number,
  category: LotCategory,
  title: string,
  shortTitle: string,
  donorName: string,
  estimatedValue: number | null,
  startingBid: number,
  minRaise: number,
];

// Exactly the approved intake table (13), in dollars. Lots 22 and 23 still need a value.
const LOT_ROWS: readonly LotRow[] = [
  [1, "pets", "Name the Next Shelter Puppy", "Name the Puppy", "Riverside Animal Shelter", 0, 100, 25],
  [2, "experiences", "Hot Air Balloon Ride for Two", "Balloon Ride", "Valley Skies Balloons", 500, 250, 25],
  [3, "experiences", "Weekend Cabin Stay", "Cabin Stay", "Pine Hollow Cabins", 600, 250, 20],
  [4, "experiences", "Riverside Theater Season Tickets", "Theater Tickets", "Riverside Theater", 480, 200, 20],
  [5, "art", "Hand-thrown Pottery Set", "Pottery Set", "Clayworks Studio", 120, 60, 10],
  [6, "experiences", "Sailing Afternoon on the Bay", "Sailing Afternoon", "Harbor Sailing Club", 400, 200, 20],
  [7, "dining", "Chef’s Table Dinner for Four", "Chef’s Table", "Oak & Ember", 480, 100, 20],
  [8, "dining", "Bakery Box for a Year", "Bakery Box", "Crumb & Co.", 240, 100, 10],
  [9, "dining", "Private Wine Tasting for Six", "Wine Tasting", "Hillside Cellars", 360, 120, 10],
  [10, "dining", "Wine Club, Six Months", "Wine Club", "Hillside Cellars", 300, 120, 10],
  [11, "experiences", "Coffee Roaster Tour", "Coffee Roaster Tour", "Northside Roasters", 80, 40, 5],
  [12, "wellness", "Spa Day for Two", "Spa Day", "Willow Street Spa", 70, 40, 5],
  [13, "wellness", "Massage Package", "Massage Package", "Still Water Massage", 180, 90, 10],
  [14, "art", "Original Watercolor “Harbor at Dusk”", "Watercolor", "Mara Lin", 300, 150, 20],
  [15, "dining", "Cooking Class for Four", "Cooking Class", "Thyme Kitchen", 240, 100, 10],
  [16, "art", "Fine-Art Photo Print", "Photo Print", "Juniper Photo", 180, 80, 10],
  [17, "art", "Ceramics Workshop for Two", "Ceramics Workshop", "Clayworks Studio", 140, 60, 10],
  [18, "experiences", "Family Portrait Session", "Family Portrait", "Bright Day Studio", 150, 60, 10],
  [19, "wellness", "Yoga, Ten Classes", "Yoga Classes", "Lotus Room", 150, 60, 10],
  [20, "pets", "Dog Grooming Package", "Dog Grooming", "Happy Tails Grooming", 120, 50, 10],
  [21, "pets", "Dog Walking, One Month", "Dog Walking", "Good Dog Walkers", 100, 40, 5],
  [22, "experiences", "Golf Lesson with a Pro", "Golf Lesson", "Cedar Hills Golf Club", null, 75, 10],
  [23, "art", "Custom Pet Portrait", "Pet Portrait", "Inkwell Pets", null, 80, 10],
  [24, "experiences", "Behind-the-Scenes Shelter Day", "Shelter Day", "Riverside Animal Shelter", 0, 50, 10],
];

// Only Lot 12's basis note and description appear on an approved screen (13).
const LOT_COPY: Readonly<Record<number, Pick<TemplateLot, "valueBasis" | "description">>> = {
  12: {
    valueBasis: "$35 × 2 passes, from the donor’s letter",
    description: "Day passes for two: pool, steam room and sauna. Valid through June 2027.",
  },
};

export const RIVERSIDE_LOTS: readonly TemplateLot[] = LOT_ROWS.map(
  ([number, category, title, shortTitle, donorName, estimatedValue, startingBid, minRaise]) => ({
    number,
    category,
    title,
    shortTitle,
    donorName,
    estimatedValueCents: estimatedValue === null ? null : dollars(estimatedValue),
    valueBasis: LOT_COPY[number]?.valueBasis ?? null,
    description: LOT_COPY[number]?.description ?? null,
    startingBidCents: dollars(startingBid),
    minRaiseCents: dollars(minRaise),
  }),
);

export function templateLot(number: number): TemplateLot {
  const lot = RIVERSIDE_LOTS.find((candidate) => candidate.number === number);
  if (!lot) throw new RangeError(`The Riverside template has no lot ${number}`);
  return lot;
}
