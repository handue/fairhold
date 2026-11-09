/**
 * Read models for the guest pages (08 catalog, 05 lot detail) and the rows they are built from.
 * Money is integer cents. Instants are epoch milliseconds everywhere: rows read them that way
 * whatever the driver does with timestamps, and views pass them to client components as numbers.
 */

/** Milliseconds since the Unix epoch. */
export type Instant = number;

export const LOT_CATEGORIES = ["dining", "experiences", "art", "wellness", "pets"] as const;
export type LotCategory = (typeof LOT_CATEGORIES)[number];

export type EventStatus = "draft" | "scheduled" | "live" | "closed" | "settling" | "settled";
export type LotStatus = "draft" | "open" | "closed";

/** The viewer's relation to one lot. */
export type ViewerLotStatus = "winning" | "outbid" | "won" | "lost" | "none";

// ---------------------------------------------------------------------------------------------
// Rows, as a GuestReadSource returns them

export interface EventRecord {
  id: string;
  slug: string;
  name: string;
  charityName: string;
  timeZone: string;
  status: EventStatus;
  opensAt: Instant;
  closesAt: Instant;
}

export interface PaddleRecord {
  id: string;
  number: number;
  firstName: string;
  /** The paddle's active (authorized) hold, or null when bidding power is not set. */
  holdCents: number | null;
  /** That hold's id, so the stream can tell a change to it from one to an older hold. */
  holdId?: string | null;
}

export interface LotRecord {
  id: string;
  number: number;
  category: LotCategory;
  title: string;
  shortTitle: string;
  donorName: string;
  /** Null until the organizer sets one ("Needs a value"). */
  estimatedValueCents: number | null;
  startingBidCents: number;
  minRaiseCents: number;
  /** Null until the first bid. */
  currentBidCents: number | null;
  bidCount: number;
  closesAt: Instant;
  status: LotStatus;
  highPaddleId: string | null;
  winningPaddleId: string | null;
  winningCents: number | null;
  coverDrawing: string | null;
}

/** What one paddle has to do with one lot; only lots with any relation are returned. */
export interface ViewerLotRecord {
  lotId: string;
  hasBid: boolean;
  isFavorite: boolean;
  inGlimPlan: boolean;
  /** The paddle's active limit on the lot (a "Max…" bid or Glim's), if any. */
  limitCents: number | null;
}

export interface LotPhotoRecord {
  drawing: string | null;
  alt: string | null;
}

export interface BidRecord {
  paddleId: string;
  paddleNumber: number;
  amountCents: number;
  createdAt: Instant;
}

/** The reads the guest pages need, so the same view code runs on Postgres and on fixtures. */
export interface GuestReadSource {
  /** The clock views are computed against; the database clock in production. */
  currentTime(): Promise<Instant>;
  /** The event's newest event_log row, read before the rows it covers; a fixture has none. */
  streamPosition?(slug: string): Promise<string>;
  findEvent(slug: string): Promise<EventRecord | null>;
  findPaddle(eventId: string, paddleNumber: number): Promise<PaddleRecord | null>;
  /** Every lot that guests can see (not drafts), in lot-number order. */
  listLots(eventId: string): Promise<LotRecord[]>;
  listViewerLots(eventId: string, paddleId: string): Promise<ViewerLotRecord[]>;
  /** The lot's photos in display order, cover first. */
  listLotPhotos(lotId: string): Promise<LotPhotoRecord[]>;
  /** The lot's most recent accepted bids, newest first. */
  listLatestBids(lotId: string, limit: number): Promise<BidRecord[]>;
}

// ---------------------------------------------------------------------------------------------
// View models

export interface EventSummary {
  slug: string;
  name: string;
  charityName: string;
  timeZone: string;
  status: EventStatus;
  opensAt: Instant;
  closesAt: Instant;
}

export interface ViewerSummary {
  paddleNumber: number;
  firstName: string;
  holdCents: number | null;
  /** What the nav shows as left: hold − leading bids − won amounts, never below zero. */
  availableCents: number;
  winningCount: number;
  outbidCount: number;
}

export interface CatalogLot {
  number: number;
  category: LotCategory;
  title: string;
  coverDrawing: string | null;
  /** The current bid, or the starting bid before anyone bids. */
  priceCents: number;
  bidCount: number;
  closesAt: Instant;
  status: LotStatus;
  viewerStatus: ViewerLotStatus;
  /** A lot the viewer hearted, has not bid on, and Glim is not bidding on. */
  offerGlimWatch: boolean;
}

export interface CatalogView {
  serverNow: Instant;
  event: EventSummary;
  viewer: ViewerSummary | null;
  /** Leading bids on open lots plus winning amounts on closed lots. */
  raisedCents: number;
  /** Every lot of the event, whatever the filter. */
  lotCount: number;
  category: LotCategory | null;
  lots: CatalogLot[];
}

export interface LotPhoto {
  drawing: string | null;
  alt: string;
}

export interface BidHistoryEntry {
  paddleNumber: number;
  isViewer: boolean;
  amountCents: number;
  placedAt: Instant;
}

export interface LotDetail {
  number: number;
  category: LotCategory;
  title: string;
  shortTitle: string;
  donorName: string;
  estimatedValueCents: number | null;
  photos: LotPhoto[];
  currentBidCents: number | null;
  startingBidCents: number;
  minRaiseCents: number;
  /** The smallest bid the engine accepts next. */
  nextMinimumCents: number;
  /** The "Raise to" choices: the next minimum, then one and three raises above it. */
  presetCents: number[];
  bidCount: number;
  closesAt: Instant;
  status: LotStatus;
  viewerStatus: ViewerLotStatus;
  isFavorite: boolean;
  limitCents: number | null;
}

export interface LotDetailView {
  serverNow: Instant;
  event: EventSummary;
  viewer: ViewerSummary | null;
  lot: LotDetail;
  history: BidHistoryEntry[];
}
