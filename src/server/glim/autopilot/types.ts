/**
 * Glim's autopilot vocabulary (docs/planning/glim-autopilot.md): the facts that wake Glim for a
 * guest, the context a decision reads, the decision itself and the change code makes of it.
 * Pure types and constant lists; nothing here reads the database, bids or calls PayPal.
 */
import type { GlimMandate } from "../mandate";
import type { GlimState } from "../types";

/** glim_autopilot_outcome; tests/unit/db/autopilot-schema-contract.test.ts checks the enum. */
export const AUTOPILOT_OUTCOMES = [
  "applied",
  "raise_prepared",
  "kept",
  "skipped",
  "stale",
  "refused",
  "failed",
  "stopped",
] as const;
export type AutopilotOutcome = (typeof AUTOPILOT_OUTCOMES)[number];

/** glim_autopilot_decider: who chose what a run did. */
export const AUTOPILOT_DECIDERS = ["model", "rule", "pending_raise", "none"] as const;
export type AutopilotDecider = (typeof AUTOPILOT_DECIDERS)[number];

/** In the order that picks a run's primary trigger. */
export const TRIGGER_KINDS = ["hold_raised", "limit_exhausted", "lot_lost", "lot_won", "closing_soon"] as const;
export type AutopilotTriggerKind = (typeof TRIGGER_KINDS)[number];

/** A fact that woke Glim, as stored in glim_autopilot.reasons. */
export type AutopilotTrigger =
  | {
      kind: "limit_exhausted";
      eventLogId: string;
      lotId: string;
      lotNumber: number;
      limitCents: number;
      currentBidCents: number;
    }
  | { kind: "lot_won"; eventLogId: string; lotId: string; lotNumber: number; amountCents: number }
  | { kind: "lot_lost"; eventLogId: string; lotId: string; lotNumber: number; winningCents: number | null }
  | { kind: "hold_raised"; eventLogId: string; holdId: string; amountCents: number }
  | { kind: "closing_soon"; lotId: string; lotNumber: number; closesAt: string };

export function triggerLotId(trigger: AutopilotTrigger): string | null {
  return trigger.kind === "hold_raised" ? null : trigger.lotId;
}

export function triggerLotNumber(trigger: AutopilotTrigger): number | null {
  return trigger.kind === "hold_raised" ? null : trigger.lotNumber;
}

/** The run's main fact: the first of its triggers in TRIGGER_KINDS order. */
export function primaryTrigger(triggers: readonly AutopilotTrigger[]): AutopilotTrigger | null {
  for (const kind of TRIGGER_KINDS) {
    const found = triggers.find((trigger) => trigger.kind === kind);
    if (found) return found;
  }
  return null;
}

export const DECISION_ACTIONS = ["keep", "change", "prepare_raise"] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

export const DECISION_REASONS = [
  "top_lot_out_of_reach",
  "money_freed",
  "priority",
  "closing_soon",
  "raise_needed",
  "nothing_fits",
  "no_change",
] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

/** One lot Glim should keep bidding on. Amounts are cents here; the model writes dollars. */
export interface AutopilotDecisionLot {
  lotNumber: number;
  /** Orders the allocator; 1 first. */
  priority: number;
  /** A ceiling below what Fairhold would give the lot, or null. */
  maxCents: number | null;
}

/** A decision, from the model (parseDecision) or from code (the rule, a pending raise). */
export interface AutopilotDecision {
  action: DecisionAction;
  /** The complete set of lots holding Glim limits after a change; ignored for keep. */
  lots: AutopilotDecisionLot[];
  /** The total bidding power to ask for, for prepare_raise. */
  raiseToCents: number | null;
  reason: DecisionReason;
  /** One sentence for the guest; shown only after filterWhy (copy.ts). */
  why: string;
}

/** One of this paddle's active limits. */
export interface AutopilotLimit {
  id: string;
  lotId: string;
  lotNumber: number;
  owner: "glim" | "guest_max";
  maxCents: number;
  createdAt: Date;
}

export interface AutopilotPlanItem {
  id: string;
  lotId: string;
  lotNumber: number;
  priority: number;
  maxCents: number;
}

export interface AutopilotPlan {
  id: string;
  version: number;
  status: "active" | "paused";
  items: AutopilotPlanItem[];
}

/** One of Glim's earlier autopilot decisions, for the brief and anti-churn. */
export interface AutopilotRecentDecision {
  actionId: string;
  at: Date;
  kind: "autopilot_changed" | "autopilot_raise_prepared";
  message: string;
  /** Lots that held Glim limits before and after it. */
  beforeLotIds: string[];
  afterLotIds: string[];
}

/**
 * A raise Glim prepared within the last ten minutes, with no decision applied since and all its
 * lots still open (§6.4). It is pending until the guest's hold reaches its amount; then it is
 * approved, and the hold_raised run applies its plan.
 */
export interface PendingRaise {
  actionId: string;
  amountCents: number;
  createdAt: Date;
  /** The guest's hold has reached the amount. */
  approved: boolean;
  /** The plan to apply once the guest's new hold lands. */
  lots: AutopilotDecisionLot[];
}

/** Everything a decision reads, from one fresh read of the paddle. */
export interface AutopilotContext {
  /** The guest's view of the auction: lots, the hold and the engine's commitments. */
  state: GlimState;
  plan: AutopilotPlan;
  mandate: GlimMandate;
  /** The paddle's active limits, of either owner. */
  limits: AutopilotLimit[];
  guestControlledLotIds: string[];
  contestedLotIds: string[];
  recentlyDroppedLotIds: string[];
  /** Newest last; the brief shows the last 3. */
  recentDecisions: AutopilotRecentDecision[];
  pendingRaise: PendingRaise | null;
  /** autopilot_raise_prepared actions so far this event. */
  raisesPrepared: number;
  triggers: AutopilotTrigger[];
}

/** A lot of the plan after a change, with the maximum the allocator gave it. */
export interface PricedLot {
  lotId: string;
  lotNumber: number;
  shortTitle: string;
  priority: number;
  /** The guest's cap and any ceiling the decision set, as the allocator used it. */
  capCents: number | null;
  floorCents: number;
  maxCents: number;
}

/** What the engine is asked to do, and what the plan items become. */
export interface AutopilotChange {
  /** The plan after the change, in priority order: every lot holding a Glim limit. */
  after: PricedLot[];
  /** Live Glim limits before the change, by lot. */
  before: { lotId: string; lotNumber: number; maxCents: number }[];
  /** New limits, and limits whose maximum changes. Unchanged ones keep their seniority. */
  set: { lotId: string; lotNumber: number; maxCents: number }[];
  /** Live Glim limits that end; bids already placed stand. */
  removeLotIds: string[];
  /** Every change only lowers or ends a limit (§5.1 R9). */
  lowerOrDropOnly: boolean;
}

export function changeIsNoop(change: AutopilotChange): boolean {
  return change.set.length === 0 && change.removeLotIds.length === 0;
}
