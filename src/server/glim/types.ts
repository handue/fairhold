/**
 * Glim's view of the auction. The read models and the engine fill these in; Glim's modules only
 * read them, so nothing here can bid or move money. Money is integer cents (USD).
 */

export type LotCategory = "dining" | "experiences" | "art" | "wellness" | "pets";

/** The guest's relation to a lot: open lots are winning, outbid or none; closed ones won or lost. */
export type GuestLotStatus = "winning" | "outbid" | "none" | "won" | "lost";

export interface GlimLotState {
  id: string;
  number: number;
  /** Organizer-entered, so it is sanitized and quoted before it reaches the model. */
  shortTitle: string;
  category: LotCategory;
  status: "draft" | "open" | "closed";
  closesAt: Date;
  currentBidCents: number | null;
  bidCount: number;
  /** The engine's next minimum: current bid plus the minimum raise, or the starting bid. */
  nextMinimumCents: number;
  minRaiseCents: number;
  guestStatus: GuestLotStatus;
}

export type CommitmentSource = "glim_limit" | "guest_max" | "winning_bid" | "won";

/** One lot's share of the hold, as the engine's commitment calculation reports it. */
export interface GlimCommitment {
  lotNumber: number;
  source: CommitmentSource;
  cents: number;
  /**
   * The same lot's commitment if Glim's limit were removed: bids already placed stand. A plan
   * change that drops a lot frees only the difference.
   */
  withoutGlimCents: number;
}

export type PlanStatus = "proposed" | "active" | "paused";

export type PlanItemStatus =
  | "watching"
  | "winning"
  | "at_limit"
  | "outbid_over_limit"
  | "won"
  | "lost"
  | "skipped";

export interface GlimPlanItemState {
  lotNumber: number;
  priority: number;
  maxCents: number;
  status: PlanItemStatus;
}

export interface GlimPlanState {
  id: string;
  status: PlanStatus;
  budgetCents: number;
  items: GlimPlanItemState[];
}

export interface GlimEventState {
  id: string;
  /** IANA zone used for every time Glim reads, e.g. America/Los_Angeles. */
  timezone: string;
  holdPresetsCents: readonly number[];
  holdMinCents: number;
  holdMaxCents: number;
}

export interface GlimGuestState {
  paddleId: string;
  paddleNumber: number;
  /** Typed by the guest at join, so it is sanitized like a lot title. */
  firstName: string;
}

export interface GlimState {
  now: Date;
  event: GlimEventState;
  guest: GlimGuestState;
  /** The paddle's active authorized hold, or null when bidding power is not set. */
  holdCents: number | null;
  /** Every lot Glim may need: the open ones and the closed ones the guest bid on. */
  lots: GlimLotState[];
  commitments: GlimCommitment[];
  /** The proposed, active or paused plan; ended and superseded plans are left out. */
  plan: GlimPlanState | null;
  favoriteLotNumbers: number[];
  /** Set when the chat was opened from a lot page ("Let Glim bid on this lot"). */
  openedFromLotNumber: number | null;
}

/** What the model asked for, converted to cents. The allocator turns it into maxima. */
export interface PlanIntentItem {
  lotNumber: number;
  /** 1 is the lot the guest wants most. */
  priority: number;
  /** The guest's own upper limit for this lot, when they named one. */
  capCents: number | null;
}

export type PlanToolName = "propose_plan" | "propose_change";

export interface PlanIntent {
  tool: PlanToolName;
  budgetCents: number | null;
  items: PlanIntentItem[];
}

export interface HoldSuggestionIntent {
  amountCents: number;
  lotNumbers: number[];
}

export type RejectReason =
  | "no_hold"
  | "empty_plan"
  | "invalid_tool_input"
  | "invalid_amount"
  | "invalid_priority"
  | "unknown_lot"
  | "duplicate_lot"
  | "lot_not_open"
  | "max_below_next_minimum"
  | "cap_above_limit"
  | "budget_over_available"
  | "total_over_limit"
  | "hold_not_higher"
  | "hold_out_of_range"
  | "hold_at_maximum";

/** One broken rule. The same record feeds the model's retry, glim_actions and the plan card. */
export interface ValidationIssue {
  reason: RejectReason;
  lotNumber: number | null;
  lotId: string | null;
  /** The rejected amount: a maximum, a cap, a budget or a hold. */
  amountCents: number | null;
  /** The bound it broke: a next minimum, the available hold or a hold limit. */
  limitCents: number | null;
  /** One plain sentence with exact amounts, written by code. */
  message: string;
}

export type GlimActionKind =
  | "plan_started"
  | "bid"
  | "raise"
  | "limit_reached"
  | "lot_won"
  | "lot_lost"
  | "paused"
  | "resumed"
  | "plan_edited"
  | "proposal_rejected"
  | "nudge";

/** A glim_actions row without its id and created_at; plan_id is filled once the plan is saved. */
export interface GlimActionRecord {
  paddleId: string;
  planId: string | null;
  lotId: string | null;
  kind: GlimActionKind;
  amountCents: number | null;
  limitCents: number | null;
  holdCentsAtTime: number | null;
  decision: "executed" | "rejected";
  rejectReason: RejectReason | null;
  message: string;
  chip: "winning" | "closed" | "none";
  triggerBidId: string | null;
}
