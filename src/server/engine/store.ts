import type { EngineEvent } from "./events";
import type {
  BidSource,
  Cents,
  CommitmentRow,
  HoldState,
  LimitOwner,
  LimitState,
  LotState,
  PaddleInfo,
} from "./types";

/*
 * The engine's persistence port. Actions (actions.ts, closing.ts) load a snapshot through an
 * EngineTx, decide everything in the pure AuctionWorkspace, then write one ChangeSet. Postgres
 * (pg-store.ts) is the production store; the unit tests drive the same actions through an
 * in-memory store, which is how the property tests reach thousands of runs.
 *
 * Lock order, which every implementation and every caller keeps, so engine transactions never
 * deadlock one another:
 *   1. lot rows, in lot-id order (lockLots)
 *   2. paddle rows, then their authorized hold rows, in paddle-id order (lockAuthorizedHolds)
 *   3. the event row (closeEventIfDone)
 *   4. the event_log ordering lock, taken by apply() as its last write
 * Limit rows change only while their lot's row lock is held, so the limits read after lockLots
 * stay current until commit.
 *
 * The paddle row guards the paddle's bidding power. Every write that changes which of its holds
 * is authorized, or that hold's amount, locks the paddle row first and keeps it until commit: the
 * PayPal raise swap (markAuthorized in src/server/paypal/hold-store.ts) today, and capture, void,
 * expiry and reauthorization when they are built. Hold rows change status, so a transaction that
 * waited on one can skip it once it is replaced; the paddle row stays, so a transaction that
 * waited on it reads the hold the writer left.
 */

export interface NewBid {
  id: string;
  lotId: string;
  paddleId: string;
  amountCents: Cents;
  source: BidSource;
  limitId: string | null;
}

export interface LotBiddingUpdate {
  lotId: string;
  currentBidCents: Cents;
  bidCount: number;
  highPaddleId: string;
  highBidSource: BidSource;
}

/** A limit created by this change set, written in its final state. */
export interface NewLimit {
  id: string;
  paddleId: string;
  lotId: string;
  maxCents: Cents;
  owner: LimitOwner;
  planItemId: string | null;
  active: boolean;
  exhausted: boolean;
}

export interface EndedLimit {
  id: string;
  /** Outbid past its max, as opposed to removed, replaced or ended by the lot's close. */
  exhausted: boolean;
}

export interface LotClose {
  lotId: string;
  winningPaddleId: string | null;
  winningCents: Cents | null;
  /**
   * Closed on demand (closeEvent) rather than because closes_at passed: closes_at moves back to
   * the moment of closing, so it still marks when bidding ended.
   */
  forced: boolean;
}

export interface ChangeSet {
  newLimits: NewLimit[];
  endedLimits: EndedLimit[];
  pausedLimitIds: string[];
  resumedLimitIds: string[];
  bids: NewBid[];
  lotUpdates: LotBiddingUpdate[];
  lotCloses: LotClose[];
  events: EngineEvent[];
}

export const EMPTY_CHANGES: Readonly<ChangeSet> = Object.freeze({
  newLimits: [],
  endedLimits: [],
  pausedLimitIds: [],
  resumedLimitIds: [],
  bids: [],
  lotUpdates: [],
  lotCloses: [],
  events: [],
});

export interface LotRef {
  id: string;
  eventId: string;
}

export interface LotBidder {
  lotId: string;
  paddleId: string;
}

export interface EngineTx {
  newId(): string;
  findPaddles(paddleIds: readonly string[]): Promise<PaddleInfo[]>;
  /** Locks the lots (FOR UPDATE) in id order; missing ids are simply absent from the result. */
  lockLots(lotIds: readonly string[]): Promise<LotState[]>;
  activeLimitsOnLots(lotIds: readonly string[]): Promise<LimitState[]>;
  /** Lots where the paddle has an active limit, optionally of one owner. Takes no locks. */
  activeLimitLotIds(paddleId: string, owner: LimitOwner | null): Promise<string[]>;
  /**
   * Locks these paddles and then their authorized holds, in paddle-id order. A paddle that comes
   * back without a hold is read again until a read finds nothing new: a swap written without the
   * paddle lock replaces the row a reader waited on, and the new row is not in that read.
   */
  lockAuthorizedHolds(paddleIds: readonly string[]): Promise<HoldState[]>;
  /** Per-lot commitments of these paddles over all lots of their events. */
  commitments(paddleIds: readonly string[]): Promise<CommitmentRow[]>;
  lotBidders(lotIds: readonly string[]): Promise<LotBidder[]>;
  /** Open lots whose closes_at has passed by the store's clock (and by `asOf`, when earlier). */
  dueLots(asOf: Date | null, limit: number): Promise<LotRef[]>;
  /** Live events that still have lots but no open ones (an earlier event close failed). */
  liveEventsWithoutOpenLots(limit: number): Promise<string[]>;
  openLotIds(eventId: string): Promise<string[]>;
  /** Moves a live event without open lots to closed; true when this call closed it. */
  closeEventIfDone(eventId: string): Promise<boolean>;
  apply(changes: ChangeSet): Promise<void>;
}

export interface EngineStore {
  /** Runs `work` in one transaction: committed if it returns, rolled back if it throws. */
  transaction<T>(work: (tx: EngineTx) => Promise<T>): Promise<T>;
}
