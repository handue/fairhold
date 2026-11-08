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
  glim: { bidders: number; winners: number; bids: number };
  checks: SettlementChecks;
  settlement: LedgerSettlement | null;
}
