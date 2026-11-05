/** Integer US cents. Every amount in the engine is one. */
export type Cents = number;

export const BID_SOURCES = ["guest", "guest_max", "glim", "bot"] as const;
export type BidSource = (typeof BID_SOURCES)[number];

/** Sources a caller can bid with directly; guest_max and glim bids only come from limits. */
export const MANUAL_BID_SOURCES = ["guest", "bot"] as const;
export type ManualBidSource = (typeof MANUAL_BID_SOURCES)[number];

export const LIMIT_OWNERS = ["guest_max", "glim"] as const;
export type LimitOwner = (typeof LIMIT_OWNERS)[number];

export type LotStatus = "draft" | "open" | "closed";
export type EventStatus = "draft" | "scheduled" | "live" | "closed" | "settling" | "settled";

/** A lot as the engine sees it inside a transaction, after its row lock is taken. */
export interface LotState {
  id: string;
  eventId: string;
  number: number;
  status: LotStatus;
  eventStatus: EventStatus;
  startingBidCents: Cents;
  minRaiseCents: Cents;
  /** Null while the lot has no bids. */
  currentBidCents: Cents | null;
  bidCount: number;
  highPaddleId: string | null;
  highBidSource: BidSource | null;
  closesAt: Date;
  /** Whether the store's clock (the database clock in production) has reached closes_at. */
  pastClose: boolean;
  winningPaddleId: string | null;
  winningCents: Cents | null;
  closedAt: Date | null;
}

/** An active proxy limit: the engine raises for its paddle by the minimum raise, up to maxCents. */
export interface LimitState {
  id: string;
  paddleId: string;
  lotId: string;
  maxCents: Cents;
  owner: LimitOwner;
  planItemId: string | null;
  paused: boolean;
  createdAt: Date;
}

export interface HoldState {
  id: string;
  paddleId: string;
  amountCents: Cents;
}

export interface PaddleInfo {
  id: string;
  eventId: string;
  number: number;
}

/** One paddle's commitment on one lot (see commitmentCents in rules.ts). */
export interface CommitmentRow {
  paddleId: string;
  lotId: string;
  cents: Cents;
}

export interface PlacedBid {
  id: string;
  lotId: string;
  paddleId: string;
  amountCents: Cents;
  source: BidSource;
  /** The limit that placed this bid, for guest_max and glim bids. */
  limitId: string | null;
}

/** A lot's bidding state after an action, with the next minimum the UI should offer. */
export interface LotView {
  id: string;
  number: number;
  currentBidCents: Cents | null;
  bidCount: number;
  highPaddleId: string | null;
  nextMinimumCents: Cents;
}

export interface LimitView {
  id: string;
  paddleId: string;
  lotId: string;
  maxCents: Cents;
  owner: LimitOwner;
  planItemId: string | null;
  /** False when the limit was already outbid past its max in the same action. */
  active: boolean;
}

export interface ClosedLotView {
  lotId: string;
  eventId: string;
  number: number;
  winningPaddleId: string | null;
  winningCents: Cents | null;
  bidCount: number;
}
