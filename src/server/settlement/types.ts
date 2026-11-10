/**
 * What the control room reads, shared by the server and the browser: only `import type` from other
 * modules, so a client component can import this file. Money is integer cents; instants are epoch
 * milliseconds, as in the guest pages' read models.
 */
import type { EventSummary, Instant } from "@/server/queries/types";

/** settlement_status, settlement_action and settlement_item_status; a test holds them to the schema. */
export const SETTLEMENT_STATUSES = ["running", "done", "done_with_errors"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_ACTIONS = ["capture", "void", "simulate"] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export const SETTLEMENT_ITEM_STATUSES = ["queued", "processing", "succeeded", "pending", "failed"] as const;
export type SettlementItemStatus = (typeof SETTLEMENT_ITEM_STATUSES)[number];

export type HoldKindLabel = "paypal" | "simulated";

// Checks -----------------------------------------------------------------------------------------

export const CHECK_KEYS = ["winners_within_holds", "glim_within_limits", "holds_valid"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

export interface CheckProblem {
  paddleNumber: number;
  bidder: string;
  /** PayPal's status or issue code, or over_hold, no_hold, over_limit, no_limit, over_authorization. */
  code: string;
  /**
   * Whether it stops the charge. A hold that won nothing only gets released, so an authorization
   * PayPal no longer honors there is noted and costs nothing.
   */
  blocking: boolean;
}

export interface SettlementCheck {
  key: CheckKey;
  /** Null until it can be decided: bidding is still open, or PayPal has not been asked yet. */
  passed: boolean | null;
  /** What it looked at: winners, Glim's bids or real holds. */
  count: number;
  problems: CheckProblem[];
}

export interface SettlementChecks {
  /** True only when every check passed; null while one is undecided. */
  passed: boolean | null;
  /** When PayPal was last asked; null when it was not. */
  ranAt: Instant | null;
  checks: SettlementCheck[];
}

// Ledger -----------------------------------------------------------------------------------------

/** One paddle's settlement item, on its ledger row. */
export interface LedgerItem {
  id: string;
  action: SettlementAction;
  status: SettlementItemStatus;
  /** PayPal's transaction id; a simulated guest never has one. */
  paypalCaptureId: string | null;
  errorCode: string | null;
}

export interface LedgerRow {
  paddleId: string;
  paddleNumber: number;
  /** "Jamie K.", or "Jamie" for a real guest, who only ever typed a first name. */
  bidder: string;
  /** As the cell shows them. */
  lotsWon: string;
  /** Every full title, for the tooltip. */
  lotsWonFull: string;
  /** Glim placed a bid for this paddle. */
  glim: boolean;
  /** Null for a winner with no authorized hold, which the first check reports. */
  holdKind: HoldKindLabel | null;
  heldCents: number;
  toChargeCents: number;
  toReleaseCents: number;
  /** Null until settlement starts. */
  item: LedgerItem | null;
}

/**
 * live: bidding is open, the figures are what each bidder would pay now.
 * ready: bidding closed, nothing charged.
 * charging, charged, failed: the settlement is running, finished, or finished with rows to retry.
 * ended: a demo that was retired before anyone charged it (src/server/director/retire.ts).
 */
export type LedgerPhase = "live" | "ready" | "charging" | "charged" | "failed" | "ended";

export interface LedgerSettlement {
  id: string;
  status: SettlementStatus;
  startedAt: Instant;
  finishedAt: Instant | null;
  winners: number;
  /** Winners whose item succeeded, simulated ones included. */
  winnersSettled: number;
  /** What those winners paid. */
  chargedCents: number;
  /** What has been released so far, won nothing and the rest of a winner's hold alike. */
  releasedCents: number;
  failed: number;
  pending: number;
  /** Still queued or processing. */
  active: number;
  /** Bidders who won nothing and whose whole hold has been released. */
  releasedInFull: number;
  /** Receipts written for this event's winners. */
  receipts: number;
}

/**
 * Glim on 12: who it bid for, and its decisions on its own (21's V6 check row), read back from
 * glim_actions and the bids themselves rather than trusted from the autopilot's own outcome.
 */
export interface LedgerGlim {
  bidders: number;
  winners: number;
  bids: number;
  /** Glim's bids above their limit or with none on record; read while bidding runs too, for the corner. */
  bidsOutsideLimits: number;
  /** Plan changes and raises Glim decided on its own, inside a guest's mandate. */
  decisions: number;
  /** Decisions whose lots or amounts fall outside the mandate they were made under. */
  decisionsOutsideRules: number;
}

export interface LedgerView {
  event: EventSummary & {
    isDemo: boolean;
    /** "Saturday, November 7, 2026" in the event's time zone. */
    dateLabel: string;
  };
  phase: LedgerPhase;
  rows: LedgerRow[];
  counts: { all: number; winners: number; nonWinners: number };
  totals: { heldCents: number; toChargeCents: number; toReleaseCents: number };
  lots: {
    total: number;
    closed: number;
    sold: number;
    /** Closed without a bid, or (while bidding runs) with no bid yet. */
    withoutBids: { number: number; title: string }[];
  };
  holds: { real: number; simulated: number };
  glim: LedgerGlim;
  checks: SettlementChecks;
  settlement: LedgerSettlement | null;
  /** The server's clock when this was read (FREEZE_CLOCK_AT outside production), for the countdown. */
  now: Instant;
}

// Insights (design/28) ----------------------------------------------------------------------------

/** One lot on Insights' "Top lots" grid. */
export interface InsightsLot {
  number: number;
  title: string;
  /** The winning bid once closed, the high bid while open; null with no bids. */
  amountCents: number | null;
  estimatedValueCents: number | null;
  bids: number;
  paddleNumber: number | null;
  /** The bid that won, or leads, was Glim's. */
  glim: boolean;
  closed: boolean;
}

/** One point of "Raised through the evening": the high bids on every lot added up at that instant. */
export interface RaisedPoint {
  at: Instant;
  cents: number;
}

/**
 * The organizer's "Tonight" report, on the same figures as 12: the ledger's view plus the lots, the
 * bids over time and Glim's limits. While bidding runs every figure is what it is now.
 */
export interface InsightsView {
  event: LedgerView["event"];
  phase: LedgerPhase;
  now: Instant;
  /** Bidders as 12 counts them, and how many are simulated guests. */
  bidders: number;
  simulatedBidders: number;
  /** A demo says which bidders are simulated; an event with only real holds has nothing to say. */
  saySimulated: boolean;
  raisedCents: number;
  /** From the open to the close, or to now while bidding runs; the chart's axis ends at the close. */
  raised: RaisedPoint[];
  window: { opensAt: Instant; closesAt: Instant };
  lots: { total: number; sold: number; open: number; withoutBids: { number: number; title: string }[] };
  bids: { total: number; glim: number };
  winners: { count: number; glim: number };
  /** "Limits kept": each of Glim's limits, by the share of it Glim's highest bid there reached. */
  limits: { shares: number[]; reached: number; passed: number; glimBids: number; glimBidsWithin: number };
  /** "Hold utilization": what was (or would be) charged against what was held. */
  holds: {
    heldCents: number;
    chargedCents: number;
    winnerHoldCents: number;
    /** Each winner's charged share of their own hold, largest first. */
    winnerShares: number[];
    nonWinners: number;
  };
  lotRows: InsightsLot[];
}
