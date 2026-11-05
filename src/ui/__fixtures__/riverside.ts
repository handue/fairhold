/**
 * The approved Jamie state of screens 08 and 05, as the rows a GuestReadSource returns.
 *
 * Saturday, November 7, 2026 at 8:58 PM in Los Angeles, 32 minutes before bidding closes. Jamie
 * (paddle 142) holds $500 with PayPal, leads Chef's Table at $320 (12 bids, closing in 18:42),
 * was outbid on Dog Walking and hearted Spa Day. The 24 lots have raised $6,840.
 *
 * The eight lots on 08's first screen carry the approved numbers; the other sixteen use the
 * approved titles, donors, values, starting bids and raises, with bids chosen to reach $6,840.
 */
import type {
  BidRecord,
  EventRecord,
  GuestReadSource,
  Instant,
  LotCategory,
  LotPhotoRecord,
  LotRecord,
  PaddleRecord,
  ViewerLotRecord,
} from "@/server/queries/types";
import type { DrawingKey } from "@/ui/drawings/drawings";
import { RIVERSIDE_LOT_DRAWINGS } from "@/ui/drawings/riverside";

const SECOND = 1_000;

/** 8:58 PM PST. */
export const FIXTURE_NOW: Instant = Date.parse("2026-11-08T04:58:00Z");

const fromNow = (minutes: number, seconds = 0): Instant => FIXTURE_NOW + (minutes * 60 + seconds) * SECOND;

/** 9:30 PM, when bidding closes and sixteen of the lots with it. */
const CLOSE = fromNow(32);

const EVENT: EventRecord = {
  id: "event-riverside",
  slug: "riverside-shelter-gala",
  name: "Riverside Shelter Gala",
  charityName: "Riverside Animal Shelter",
  timeZone: "America/Los_Angeles",
  status: "live",
  opensAt: Date.parse("2026-11-08T03:00:00Z"),
  closesAt: CLOSE,
};

const JAMIE: PaddleRecord = { id: "paddle-142", number: 142, firstName: "Jamie", holdCents: 50_000 };

/** Simulated guests who bid in the fixture, by paddle number. */
const OTHER_BIDDERS = [88, 104, 109, 117, 121, 131, 133, 138, 147, 156, 163, 168, 175];

interface FixtureLot {
  number: number;
  category: LotCategory;
  title: string;
  shortTitle: string;
  donor: string;
  /** Whole dollars. */
  value: number | null;
  start: number;
  raise: number;
  current: number | null;
  bids: number;
  closesAt: Instant;
  /** The latest bidders, newest first; older bids rotate through OTHER_BIDDERS. */
  latestBidders: number[];
}

const LOTS: FixtureLot[] = [
  { number: 1, category: "pets", title: "Name the Next Shelter Puppy", shortTitle: "Shelter Puppy", donor: "Riverside Animal Shelter", value: 0, start: 100, raise: 25, current: 1400, bids: 21, closesAt: CLOSE, latestBidders: [175] },
  { number: 2, category: "experiences", title: "Hot Air Balloon Ride for Two", shortTitle: "Balloon Ride", donor: "Valley Skies Balloons", value: 500, start: 250, raise: 25, current: 650, bids: 12, closesAt: CLOSE, latestBidders: [168] },
  { number: 3, category: "experiences", title: "Weekend Cabin Stay", shortTitle: "Cabin Stay", donor: "Pine Hollow Cabins", value: 600, start: 250, raise: 20, current: 640, bids: 19, closesAt: fromNow(7, 55), latestBidders: [104] },
  { number: 4, category: "experiences", title: "Riverside Theater Season Tickets", shortTitle: "Theater Tickets", donor: "Riverside Theater", value: 480, start: 200, raise: 20, current: 520, bids: 11, closesAt: CLOSE, latestBidders: [121] },
  { number: 5, category: "art", title: "Hand-thrown Pottery Set", shortTitle: "Pottery Set", donor: "Clayworks Studio", value: 120, start: 60, raise: 10, current: 150, bids: 8, closesAt: fromNow(9, 30), latestBidders: [131] },
  { number: 6, category: "experiences", title: "Sailing Afternoon on the Bay", shortTitle: "Sailing", donor: "Harbor Sailing Club", value: 400, start: 200, raise: 20, current: 440, bids: 9, closesAt: CLOSE, latestBidders: [138] },
  { number: 7, category: "dining", title: "Chef’s Table Dinner for Four", shortTitle: "Chef’s Table", donor: "Oak & Ember", value: 480, start: 100, raise: 20, current: 320, bids: 12, closesAt: fromNow(18, 42), latestBidders: [142, 88] },
  { number: 8, category: "dining", title: "Bakery Box for a Year", shortTitle: "Bakery Box", donor: "Crumb & Co.", value: 240, start: 100, raise: 10, current: 260, bids: 8, closesAt: CLOSE, latestBidders: [156] },
  { number: 9, category: "dining", title: "Private Wine Tasting for Six", shortTitle: "Wine Tasting", donor: "Hillside Cellars", value: 360, start: 120, raise: 10, current: 210, bids: 10, closesAt: fromNow(12, 5), latestBidders: [133] },
  { number: 10, category: "dining", title: "Wine Club, Six Months", shortTitle: "Wine Club", donor: "Hillside Cellars", value: 300, start: 120, raise: 10, current: 250, bids: 7, closesAt: CLOSE, latestBidders: [133] },
  { number: 11, category: "experiences", title: "Coffee Roaster Tour", shortTitle: "Coffee Roaster Tour", donor: "Northside Roasters", value: 80, start: 40, raise: 5, current: 95, bids: 6, closesAt: CLOSE, latestBidders: [156] },
  { number: 12, category: "wellness", title: "Spa Day for Two", shortTitle: "Spa Day", donor: "Willow Street Spa", value: 70, start: 40, raise: 5, current: 85, bids: 4, closesAt: fromNow(26, 10), latestBidders: [109] },
  { number: 13, category: "wellness", title: "Massage Package", shortTitle: "Massage", donor: "Still Water Massage", value: 180, start: 90, raise: 10, current: 180, bids: 6, closesAt: CLOSE, latestBidders: [147] },
  // Lot 14 closes 20 seconds before the rest, as on the projector (14).
  { number: 14, category: "art", title: "Original Watercolor “Harbor at Dusk”", shortTitle: "Watercolor", donor: "Mara Lin", value: 300, start: 150, raise: 20, current: 275, bids: 7, closesAt: fromNow(31, 40), latestBidders: [163] },
  { number: 15, category: "dining", title: "Cooking Class for Four", shortTitle: "Cooking Class", donor: "Thyme Kitchen", value: 240, start: 100, raise: 10, current: 210, bids: 7, closesAt: CLOSE, latestBidders: [121] },
  { number: 16, category: "art", title: "Fine-Art Photo Print", shortTitle: "Photo Print", donor: "Juniper Photo", value: 180, start: 80, raise: 10, current: 140, bids: 5, closesAt: CLOSE, latestBidders: [104] },
  { number: 17, category: "art", title: "Ceramics Workshop for Two", shortTitle: "Ceramics Workshop", donor: "Clayworks Studio", value: 140, start: 60, raise: 10, current: 130, bids: 6, closesAt: CLOSE, latestBidders: [168] },
  { number: 18, category: "experiences", title: "Family Portrait Session", shortTitle: "Family Portrait", donor: "Bright Day Studio", value: 150, start: 60, raise: 10, current: 120, bids: 5, closesAt: fromNow(22, 15), latestBidders: [109] },
  { number: 19, category: "wellness", title: "Yoga, Ten Classes", shortTitle: "Yoga", donor: "Lotus Room", value: 150, start: 60, raise: 10, current: 110, bids: 4, closesAt: CLOSE, latestBidders: [138] },
  { number: 20, category: "pets", title: "Dog Grooming Package", shortTitle: "Dog Grooming", donor: "Happy Tails Grooming", value: 120, start: 50, raise: 10, current: 120, bids: 5, closesAt: CLOSE, latestBidders: [175] },
  { number: 21, category: "pets", title: "Dog Walking, One Month", shortTitle: "Dog Walking", donor: "Good Dog Walkers", value: 100, start: 40, raise: 5, current: 95, bids: 6, closesAt: fromNow(15, 20), latestBidders: [117, 142] },
  { number: 22, category: "experiences", title: "Golf Lesson with a Pro", shortTitle: "Golf Lesson", donor: "Cedar Hills Golf Club", value: null, start: 75, raise: 10, current: null, bids: 0, closesAt: CLOSE, latestBidders: [] },
  { number: 23, category: "art", title: "Custom Pet Portrait", shortTitle: "Pet Portrait", donor: "Inkwell Pets", value: null, start: 80, raise: 10, current: 180, bids: 6, closesAt: CLOSE, latestBidders: [117] },
  { number: 24, category: "experiences", title: "Behind-the-Scenes Shelter Day", shortTitle: "Shelter Day", donor: "Riverside Animal Shelter", value: 0, start: 50, raise: 10, current: 260, bids: 9, closesAt: CLOSE, latestBidders: [147] },
];

const JAMIE_FAVORITES = new Set([12]);

const PHOTO_ALTS: Partial<Record<DrawingKey, string>> = {
  cloche: "A silver cloche on the chef’s table",
  "wine-glass": "The wine pairing",
  "chef-hat": "The chef",
  "menu-card": "The tasting menu",
  "spa-stones": "Warm stones and a leaf",
  steam: "The steam room",
  "day-passes": "Two day passes",
};

const paddleId = (paddleNumber: number) => `paddle-${paddleNumber}`;
const lotId = (lotNumber: number) => `lot-${lotNumber}`;
const cents = (dollars: number) => dollars * 100;

function toLotRecord(lot: FixtureLot): LotRecord {
  const highBidder = lot.latestBidders[0];
  return {
    id: lotId(lot.number),
    number: lot.number,
    category: lot.category,
    title: lot.title,
    shortTitle: lot.shortTitle,
    donorName: lot.donor,
    estimatedValueCents: lot.value === null ? null : cents(lot.value),
    startingBidCents: cents(lot.start),
    minRaiseCents: cents(lot.raise),
    currentBidCents: lot.current === null ? null : cents(lot.current),
    bidCount: lot.bids,
    closesAt: lot.closesAt,
    status: "open",
    highPaddleId: highBidder === undefined ? null : paddleId(highBidder),
    winningPaddleId: null,
    winningCents: null,
    coverDrawing: RIVERSIDE_LOT_DRAWINGS[lot.number]?.[0] ?? null,
  };
}

/** Every accepted bid, newest first: one minimum raise apart, the newest 2 min 10 s ago. */
function bidsFor(lot: FixtureLot): BidRecord[] {
  if (lot.current === null) return [];
  const bidders = [...lot.latestBidders];
  for (let index = bidders.length; index < lot.bids; index += 1) {
    const previous = bidders[index - 1];
    let next = OTHER_BIDDERS[(lot.number * 3 + index) % OTHER_BIDDERS.length]!;
    if (next === previous) next = OTHER_BIDDERS[(lot.number * 3 + index + 1) % OTHER_BIDDERS.length]!;
    bidders.push(next);
  }

  let placedAt = FIXTURE_NOW - 130 * SECOND;
  return bidders.map((bidder, index) => {
    const bid: BidRecord = {
      paddleId: paddleId(bidder),
      paddleNumber: bidder,
      amountCents: cents(lot.current! - index * lot.raise),
      createdAt: placedAt,
    };
    placedAt -= (index === 0 ? 190 : 240) * SECOND;
    return bid;
  });
}

const LOT_RECORDS = LOTS.map(toLotRecord);
const BIDS = new Map(LOTS.map((lot) => [lotId(lot.number), bidsFor(lot)]));

export const riversideFixtureSource: GuestReadSource = {
  async currentTime() {
    return FIXTURE_NOW;
  },

  async findEvent(slug) {
    return slug === EVENT.slug ? EVENT : null;
  },

  async findPaddle(eventId, paddleNumber) {
    return eventId === EVENT.id && paddleNumber === JAMIE.number ? JAMIE : null;
  },

  async listLots(eventId) {
    return eventId === EVENT.id ? LOT_RECORDS : [];
  },

  async listViewerLots(eventId, viewerId) {
    if (eventId !== EVENT.id) return [];
    return LOTS.flatMap((lot): ViewerLotRecord[] => {
      const hasBid = (BIDS.get(lotId(lot.number)) ?? []).some((bid) => bid.paddleId === viewerId);
      const isFavorite = viewerId === JAMIE.id && JAMIE_FAVORITES.has(lot.number);
      if (!hasBid && !isFavorite) return [];
      return [{ lotId: lotId(lot.number), hasBid, isFavorite, inGlimPlan: false, limitCents: null }];
    });
  },

  async listLotPhotos(id) {
    const lot = LOTS.find((candidate) => lotId(candidate.number) === id);
    const drawings = lot ? (RIVERSIDE_LOT_DRAWINGS[lot.number] ?? []) : [];
    return drawings.map((drawing): LotPhotoRecord => ({ drawing, alt: PHOTO_ALTS[drawing] ?? null }));
  },

  async listLatestBids(id, limit) {
    return (BIDS.get(id) ?? []).slice(0, limit);
  },
};
