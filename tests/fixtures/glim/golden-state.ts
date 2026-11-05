/**
 * Jamie's approved state at 9:11 PM on the gala night, the moment 07 shows: $500 held, winning
 * Lot 07 at $320, Spa Day at $85, outbid on Dog Walking, no plan yet. Lots 03, 05, 07, 09, 12, 14,
 * 18 and 21 carry 08's approved bids and close times; the rest of the 24-lot table (item intake's
 * values) has no bids yet and closes with the event at 9:30 PM.
 */
import type { GlimLotState, GlimState, LotCategory } from "@/server/glim/types";

export const GOLDEN_SENTENCE = "$500. I really want the chef's dinner. Spa only under $120.";

/** What the golden sentence must produce (build plan, Day 1 exit). */
export const GOLDEN_PLAN = [
  { lotNumber: 7, shortTitle: "Chef's Table", maxCents: 38_000 },
  { lotNumber: 12, shortTitle: "Spa Day", maxCents: 12_000 },
] as const;

/** 9:11:18 PM PST on Saturday, November 7, 2026. */
export const GOLDEN_NOW = new Date("2026-11-08T05:11:18Z");
const EVENT_CLOSE = new Date("2026-11-08T05:30:00Z");

type LotRow = [
  number: number,
  shortTitle: string,
  category: LotCategory,
  startingBidCents: number,
  minRaiseCents: number,
];

const LOT_TABLE: LotRow[] = [
  [1, "Name the Puppy", "pets", 10_000, 2_500],
  [2, "Balloon Ride", "experiences", 25_000, 2_500],
  [3, "Cabin Stay", "experiences", 25_000, 2_000],
  [4, "Theater Tickets", "experiences", 20_000, 2_000],
  [5, "Pottery Set", "art", 6_000, 1_000],
  [6, "Sailing Afternoon", "experiences", 20_000, 2_000],
  [7, "Chef's Table", "dining", 10_000, 2_000],
  [8, "Bakery Box", "dining", 10_000, 1_000],
  [9, "Wine Tasting", "dining", 12_000, 1_000],
  [10, "Wine Club", "dining", 12_000, 1_000],
  [11, "Roaster Tour", "experiences", 4_000, 500],
  [12, "Spa Day", "wellness", 4_000, 500],
  [13, "Massage Package", "wellness", 9_000, 1_000],
  [14, "Watercolor", "art", 15_000, 2_000],
  [15, "Cooking Class", "dining", 10_000, 1_000],
  [16, "Photo Print", "art", 8_000, 1_000],
  [17, "Ceramics Workshop", "art", 6_000, 1_000],
  [18, "Family Portrait", "experiences", 6_000, 1_000],
  [19, "Yoga Classes", "wellness", 6_000, 1_000],
  [20, "Dog Grooming", "pets", 5_000, 1_000],
  [21, "Dog Walking", "pets", 4_000, 500],
  [22, "Golf Lesson", "experiences", 7_500, 1_000],
  [23, "Pet Portrait", "art", 8_000, 1_000],
  [24, "Shelter Day", "experiences", 5_000, 1_000],
];

/** 08's approved bids: current bid, bid count, minutes and seconds left at 9:11:18, Jamie's status. */
const BIDDING: Record<number, { currentBidCents: number; bidCount: number; left: [number, number] | null; you: GlimLotState["guestStatus"] }> = {
  3: { currentBidCents: 64_000, bidCount: 19, left: [7, 55], you: "none" },
  5: { currentBidCents: 15_000, bidCount: 8, left: [9, 30], you: "none" },
  7: { currentBidCents: 32_000, bidCount: 12, left: [18, 42], you: "winning" },
  9: { currentBidCents: 21_000, bidCount: 10, left: [12, 5], you: "none" },
  12: { currentBidCents: 8_500, bidCount: 4, left: null, you: "none" },
  14: { currentBidCents: 27_500, bidCount: 7, left: null, you: "none" },
  18: { currentBidCents: 12_000, bidCount: 5, left: null, you: "none" },
  21: { currentBidCents: 9_500, bidCount: 6, left: [15, 20], you: "outbid" },
};

function lotState([number, shortTitle, category, startingBidCents, minRaiseCents]: LotRow): GlimLotState {
  const bidding = BIDDING[number];
  const closesAt = bidding?.left
    ? new Date(GOLDEN_NOW.getTime() + (bidding.left[0] * 60 + bidding.left[1]) * 1000)
    : EVENT_CLOSE;
  return {
    id: `00000000-0000-4000-8000-0000000000${String(number).padStart(2, "0")}`,
    number,
    shortTitle,
    category,
    status: "open",
    closesAt,
    currentBidCents: bidding?.currentBidCents ?? null,
    bidCount: bidding?.bidCount ?? 0,
    nextMinimumCents: bidding ? bidding.currentBidCents + minRaiseCents : startingBidCents,
    minRaiseCents,
    guestStatus: bidding?.you ?? "none",
  };
}

/** A fresh copy each call, so a test can change it freely. */
export function createGoldenState(): GlimState {
  return {
    now: new Date(GOLDEN_NOW),
    event: {
      id: "00000000-0000-4000-8000-00000000e001",
      timezone: "America/Los_Angeles",
      holdPresetsCents: [25_000, 50_000, 100_000],
      holdMinCents: 5_000,
      holdMaxCents: 100_000,
    },
    guest: { paddleId: "00000000-0000-4000-8000-000000000142", paddleNumber: 142, firstName: "Jamie" },
    holdCents: 50_000,
    lots: LOT_TABLE.map(lotState),
    commitments: [{ lotNumber: 7, source: "winning_bid", cents: 32_000, withoutGlimCents: 32_000 }],
    plan: null,
    favoriteLotNumbers: [7, 12],
    openedFromLotNumber: 7,
  };
}

export function lotByNumber(state: GlimState, number: number): GlimLotState {
  const lot = state.lots.find((candidate) => candidate.number === number);
  if (!lot) throw new Error(`No Lot ${number} in the fixture`);
  return lot;
}
