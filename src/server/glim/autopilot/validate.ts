/**
 * Every autopilot decision passes these rules before anything is applied
 * (docs/planning/glim-autopilot.md §5.1). The mandate rules R1–R5 are also one pure function,
 * mandateViolations, which the apply transaction runs again under its row locks. Amounts never
 * come from the model: the allocator prices the lots, with the budget the mandate allows (§2.4).
 * A broken mandate rule rejects the whole decision and the deterministic rule decides instead;
 * a price that does not fit is only ever lowered or dropped (clampPlan).
 */
import { distributeMaxima, minimumMaxCents, type PlanLot } from "../allocator";
import {
  budgetForPlan,
  CLOSE_MARGIN_MS,
  lotBlocker,
  mandateLot,
  mandateLotNumbers,
  mandateRank,
  type GlimMandate,
  type LotAvailability,
} from "../mandate";
import { formatUsd } from "../money";
import { isOpenForBids, lotLabel } from "../prompt";
import type { GlimLotState, GlimState, PlanIntent, RejectReason, ValidationIssue } from "../types";
import { checkPlan, clampPlan } from "../validator";

import {
  changeIsNoop,
  type AutopilotChange,
  type AutopilotContext,
  type AutopilotDecision,
  type AutopilotDecisionLot,
  type AutopilotLimit,
  type PricedLot,
} from "./types";

/** At most this many lots hold Glim limits after an autopilot change (R5). */
export const MAX_AUTOPILOT_LOTS = 6;
/** At most this many raises are prepared per paddle per event (R10). */
export const MAX_RAISES_PER_PADDLE = 2;
const WHOLE_DOLLAR = 100;
const TEN_DOLLARS = 1_000;

function issue(
  reason: RejectReason,
  message: string,
  fields: { lot?: Pick<GlimLotState, "id" | "number">; lotNumber?: number; amountCents?: number | null; limitCents?: number | null } = {},
): ValidationIssue {
  return {
    reason,
    lotNumber: fields.lot?.number ?? fields.lotNumber ?? null,
    lotId: fields.lot?.id ?? null,
    amountCents: fields.amountCents ?? null,
    limitCents: fields.limitCents ?? null,
    message,
  };
}

/** The paddle's active Glim limits, by lot id: the lots that are "live". */
export function liveGlimLimits(context: Pick<AutopilotContext, "limits">): Map<string, AutopilotLimit> {
  return new Map(context.limits.filter((limit) => limit.owner === "glim").map((limit) => [limit.lotId, limit]));
}

export function lotAvailability(
  context: Pick<AutopilotContext, "state" | "guestControlledLotIds" | "contestedLotIds" | "recentlyDroppedLotIds">,
): LotAvailability {
  return {
    now: context.state.now,
    guestControlledLotIds: new Set(context.guestControlledLotIds),
    contestedLotIds: new Set(context.contestedLotIds),
    recentlyDroppedLotIds: new Set(context.recentlyDroppedLotIds),
  };
}

const BLOCKER_MESSAGE: Record<NonNullable<ReturnType<typeof lotBlocker>>, string> = {
  outside_mandate: "is not one of the lots the guest let Glim use",
  excluded_lot: "is a lot the guest ruled out",
  closes_too_soon: "closes too soon for a new limit",
  guest_controlled_lot: "has the guest's own maximum, so only the guest bids there",
  contested_lot: "has another bidder's higher limit; Glim's last limit there was outbid at once",
  recently_dropped: "was dropped by Glim in the last two minutes",
};

/** What the decision's check produced: the priced plan and the change to apply. */
export interface CheckedChange {
  ok: true;
  plan: PricedLot[];
  /** budget(P) at the hold the check ran with. */
  budgetCents: number;
  change: AutopilotChange;
  /** Code lowered or dropped something the decision asked for. */
  adjusted: boolean;
  adjustments: ValidationIssue[];
}

export interface RejectedChange {
  ok: false;
  issues: ValidationIssue[];
  /** What the allocator would have given each lot, when the lots themselves were acceptable. */
  attempt: Map<number, number> | null;
}

export type ChangeCheck = CheckedChange | RejectedChange;

interface ResolvedLot {
  lot: GlimLotState;
  priority: number;
  guestCap: number | null;
  ceiling: number | null;
}

const minCap = (...caps: (number | null)[]): number | null => {
  const present = caps.filter((cap): cap is number => cap !== null);
  return present.length === 0 ? null : Math.min(...present);
};

/**
 * The allocator's caps for the decided lots. A decision's ceiling can only lower a lot: it never
 * gives a lot more than the allocator would without that ceiling, and never more than the
 * guest's cap (R4, applied before this). A ceiling on one lot frees money for the next one.
 */
function allocatorCaps(lots: readonly ResolvedLot[], limitCents: number): Map<number, number | null> {
  const base = (lot: ResolvedLot) => minCap(lot.guestCap, lot.ceiling);
  const caps = new Map(lots.map((lot) => [lot.lot.number, base(lot)]));
  for (const lot of lots) {
    if (lot.ceiling === null) continue;
    const without: PlanLot[] = lots.map((other) => ({
      lot: other.lot,
      priority: other.priority,
      capCents: other === lot ? other.guestCap : base(other),
    }));
    const natural = distributeMaxima(without, limitCents).find((item) => item.lot.number === lot.lot.number)?.maxCents ?? 0;
    caps.set(lot.lot.number, minCap(base(lot), natural));
  }
  return caps;
}

function rankOf(mandate: GlimMandate, lotId: string): number {
  return mandateRank(mandate, lotId) ?? Number.POSITIVE_INFINITY;
}

/** The change from the live limits to this plan. */
export function buildChange(after: readonly PricedLot[], live: ReadonlyMap<string, AutopilotLimit>): AutopilotChange {
  const before = [...live.values()]
    .map((limit) => ({ lotId: limit.lotId, lotNumber: limit.lotNumber, maxCents: limit.maxCents }))
    .sort((a, b) => a.lotNumber - b.lotNumber);
  const kept = new Set(after.map((lot) => lot.lotId));
  return {
    after: [...after],
    before,
    set: after
      .filter((lot) => live.get(lot.lotId)?.maxCents !== lot.maxCents)
      .map((lot) => ({ lotId: lot.lotId, lotNumber: lot.lotNumber, maxCents: lot.maxCents })),
    removeLotIds: before.filter((limit) => !kept.has(limit.lotId)).map((limit) => limit.lotId),
    lowerOrDropOnly: after.every((lot) => {
      const previous = live.get(lot.lotId);
      return previous !== undefined && lot.maxCents <= previous.maxCents;
    }),
  };
}

/**
 * R7: money only moves toward lots the guest ranked at least as high. For every live lot that
 * loses (a lower maximum, or dropped) and every lot that gains (a higher maximum, or added), the
 * gainer's rank must not be below the loser's.
 */
export function rankingViolations(change: AutopilotChange, mandate: GlimMandate): ValidationIssue[] {
  const afterMax = new Map(change.after.map((lot) => [lot.lotId, lot.maxCents]));
  const beforeMax = new Map(change.before.map((lot) => [lot.lotId, lot.maxCents]));
  const losers = change.before.filter((lot) => (afterMax.get(lot.lotId) ?? 0) < lot.maxCents);
  const gainers = change.after.filter((lot) => lot.maxCents > (beforeMax.get(lot.lotId) ?? 0));
  for (const gainer of gainers) {
    const loser = losers.find((candidate) => rankOf(mandate, gainer.lotId) > rankOf(mandate, candidate.lotId));
    if (loser) {
      return [
        issue(
          "ranking_broken",
          `Lot ${gainer.lotNumber} would gain at the expense of Lot ${loser.lotNumber}, which the guest ranked higher.`,
          { lotNumber: gainer.lotNumber, amountCents: gainer.maxCents },
        ),
      ];
    }
  }
  return [];
}

export function isLowerOrDropOnly(change: AutopilotChange): boolean {
  return change.lowerOrDropOnly;
}

export interface MandateFacts {
  now: Date;
  /** The lots the change writes, as read under their row locks; a missing lot counts as closed. */
  lots: ReadonlyMap<string, { closesAt: Date; open: boolean }>;
  guestControlledLotIds: ReadonlySet<string>;
}

/**
 * A change's two halves must agree: the limits handed to the engine (`set`) are lots of the plan
 * after the change (`after`) with the same maxima, and no lot it ends (`removeLotIds`) stays in
 * that plan. buildChange always keeps them so; the apply transaction checks it anyway, because it
 * writes `set` while the mandate rules read `after`. Any hit is a bug, never a race.
 */
export function inconsistentChange(change: AutopilotChange): ValidationIssue[] {
  const after = new Map(change.after.map((lot) => [lot.lotId, lot.maxCents]));
  const issues: ValidationIssue[] = [];
  for (const lot of change.set) {
    const planned = after.get(lot.lotId);
    if (planned !== lot.maxCents) {
      const ref = { lot: { id: lot.lotId, number: lot.lotNumber }, amountCents: lot.maxCents, limitCents: planned ?? null };
      issues.push(
        issue(
          "inconsistent_change",
          planned === undefined
            ? `Lot ${lot.lotNumber} would get a Glim limit but is not in the plan after the change.`
            : `Lot ${lot.lotNumber} would get a ${formatUsd(lot.maxCents)} limit while the plan gives it ${formatUsd(planned)}.`,
          ref,
        ),
      );
    }
  }
  for (const lotId of change.removeLotIds) {
    const kept = change.after.find((lot) => lot.lotId === lotId);
    if (kept) {
      issues.push(issue("inconsistent_change", `Lot ${kept.lotNumber} would lose its Glim limit but stays in the plan.`, { lot: { id: lotId, number: kept.lotNumber } }));
    }
  }
  return issues;
}

/**
 * R1–R5 on a change, with no other context: every lot in the mandate and not ruled out, none
 * under the guest's own maximum, every maximum within the guest's cap, at most six lots, and no
 * new or changed limit on a lot that closes within 5 s. The lot rules cover both the plan after
 * the change and every limit it writes (`set`), so they hold for what the engine is handed even
 * when the two disagree. The apply transaction runs this again on what it read under its locks.
 */
export function mandateViolations(change: AutopilotChange, mandate: GlimMandate, facts: MandateFacts): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (change.after.length > MAX_AUTOPILOT_LOTS) {
    issues.push(issue("too_many_lots", `The plan would hold ${change.after.length} lots; autopilot keeps at most ${MAX_AUTOPILOT_LOTS}.`));
  }
  const planned = (lot: { lotId: string; maxCents: number }) =>
    change.after.some((entry) => entry.lotId === lot.lotId && entry.maxCents === lot.maxCents);
  const lots = [...change.after, ...change.set.filter((lot) => !planned(lot))];
  for (const lot of lots) {
    const ref = { id: lot.lotId, number: lot.lotNumber };
    const mandated = mandateLot(mandate, lot.lotId);
    if (mandate.excludedLotIds.includes(lot.lotId)) {
      issues.push(issue("excluded_lot", `Lot ${lot.lotNumber} is a lot the guest ruled out.`, { lot: ref }));
    } else if (!mandated) {
      issues.push(issue("outside_mandate", `Lot ${lot.lotNumber} is not one of the lots the guest let Glim use.`, { lot: ref }));
    } else if (mandated.capCents !== null && lot.maxCents > mandated.capCents) {
      issues.push(
        issue("above_guest_cap", `Lot ${lot.lotNumber}'s maximum ${formatUsd(lot.maxCents)} is above the guest's cap of ${formatUsd(mandated.capCents)}.`, {
          lot: ref,
          amountCents: lot.maxCents,
          limitCents: mandated.capCents,
        }),
      );
    }
    if (facts.guestControlledLotIds.has(lot.lotId)) {
      issues.push(issue("guest_controlled_lot", `Lot ${lot.lotNumber} has the guest's own maximum.`, { lot: ref }));
    }
  }
  for (const lot of change.set) {
    const read = facts.lots.get(lot.lotId);
    if (!read || !read.open || read.closesAt.getTime() - facts.now.getTime() <= CLOSE_MARGIN_MS) {
      issues.push(issue("closes_too_soon", `Lot ${lot.lotNumber} closes too soon for a new limit.`, { lot: { id: lot.lotId, number: lot.lotNumber } }));
    }
  }
  return issues;
}

/**
 * R1–R9 for the plan a decision asks for: the lots Glim should hold limits on afterwards. The
 * check runs at the guest's hold, or at `holdCents` when a raise is being sized.
 */
export function checkChange(
  lots: readonly AutopilotDecisionLot[],
  context: AutopilotContext,
  options: { holdCents?: number } = {},
): ChangeCheck {
  const { state, mandate } = context;
  const holdCents = options.holdCents ?? state.holdCents;
  if (holdCents === null) {
    return { ok: false, issues: [issue("no_hold", "Bidding power isn't set, so Glim cannot plan.")], attempt: null };
  }
  const live = liveGlimLimits(context);
  const facts = lotAvailability(context);
  const lotsByNumber = new Map(state.lots.map((lot) => [lot.number, lot]));

  const issues: ValidationIssue[] = [];
  if (lots.length > MAX_AUTOPILOT_LOTS) {
    issues.push(issue("too_many_lots", `The decision names ${lots.length} lots; autopilot keeps at most ${MAX_AUTOPILOT_LOTS}.`));
  }
  const resolved: ResolvedLot[] = [];
  for (const item of lots) {
    const mandated = mandate.lots.find((lot) => lot.lotNumber === item.lotNumber);
    const lot = lotsByNumber.get(item.lotNumber);
    if (!mandated || (lot && lot.id !== mandated.lotId)) {
      issues.push(issue("outside_mandate", `Lot ${item.lotNumber} ${BLOCKER_MESSAGE.outside_mandate}.`, { lot, lotNumber: item.lotNumber }));
      continue;
    }
    if (!lot) {
      issues.push(issue("closes_too_soon", `Lot ${item.lotNumber} is closed.`, { lotNumber: item.lotNumber }));
      continue;
    }
    const blocker = lotBlocker(lot, mandate, facts);
    // A live limit may stay as it is on a lot that closes soon; whether it changes is checked below.
    const tolerated = live.has(lot.id) && (blocker === "closes_too_soon" || blocker === "contested_lot" || blocker === "recently_dropped");
    if (blocker && !tolerated) {
      issues.push(issue(blocker, `${lotLabel(lot)} ${BLOCKER_MESSAGE[blocker]}.`, { lot }));
      continue;
    }
    resolved.push({ lot, priority: item.priority, guestCap: mandated.capCents, ceiling: item.maxCents });
  }
  if (issues.length > 0) return { ok: false, issues, attempt: null };

  const adjustments: ValidationIssue[] = [];
  // R4: a ceiling above the guest's cap is set to the cap.
  for (const lot of resolved) {
    if (lot.ceiling !== null && lot.guestCap !== null && lot.ceiling > lot.guestCap) {
      adjustments.push(
        issue("above_guest_cap", `${lotLabel(lot.lot)}: ${formatUsd(lot.ceiling)} was set to the guest's cap of ${formatUsd(lot.guestCap)}.`, {
          lot: lot.lot,
          amountCents: lot.ceiling,
          limitCents: lot.guestCap,
        }),
      );
      lot.ceiling = lot.guestCap;
    }
  }

  const stateAtHold: GlimState = holdCents === state.holdCents ? state : { ...state, holdCents };
  const pricing = priceLots(resolved, mandate, stateAtHold, holdCents, adjustments);
  let priced = pricing.priced;
  const { attempt } = pricing;

  // R9: a decision that keeps only live lots may always lower or drop, even over the budget.
  if (priced === null && resolved.every((lot) => live.has(lot.lot.id))) {
    priced = lowerOrDrop(resolved, live, adjustments);
  }
  if (priced === null) {
    return {
      ok: false,
      issues: [issue("nothing_fits", "Nothing in the decision fits the budget, the bidding power and the lots' next minimums.")],
      attempt,
    };
  }

  const change = buildChange(priced, live);
  const closing = change.set.flatMap((set) => {
    const lot = lotsByNumber.get(set.lotNumber);
    const soon = !lot || !isOpenForBids(lot, state.now) || lot.closesAt.getTime() - state.now.getTime() <= CLOSE_MARGIN_MS;
    return soon ? [issue("closes_too_soon", `Lot ${set.lotNumber} closes too soon to change Glim's limit there.`, { lotNumber: set.lotNumber })] : [];
  });
  if (closing.length > 0) return { ok: false, issues: closing, attempt };
  const ranking = rankingViolations(change, mandate);
  if (ranking.length > 0) return { ok: false, issues: ranking, attempt };
  return { ok: true, plan: priced, budgetCents: pricing.budgetCents, change, adjusted: adjustments.length > 0, adjustments };
}

/**
 * R8 with budget(P): the allocator prices the lots and checkPlan checks open lots, floors and the
 * total. A plan that fails is clamped, which only lowers or drops. When the clamp drops a lot of
 * the mandate, budget(P) changes with P (what stays committed there now counts against the
 * guest's budget), so the smaller plan is priced again from the start.
 */
function priceLots(
  resolved: readonly ResolvedLot[],
  mandate: GlimMandate,
  state: GlimState,
  holdCents: number,
  adjustments: ValidationIssue[],
): { priced: PricedLot[] | null; budgetCents: number; attempt: Map<number, number> | null } {
  let current = [...resolved];
  let attempt: Map<number, number> | null = null;
  let budgetCents = 0;
  const toPriced = (items: readonly { lot: GlimLotState; priority: number; capCents: number | null; floorCents: number; maxCents: number }[]) =>
    items.map((item) => ({
      lotId: item.lot.id,
      lotNumber: item.lot.number,
      shortTitle: item.lot.shortTitle,
      priority: item.priority,
      capCents: item.capCents,
      floorCents: item.floorCents,
      maxCents: item.maxCents,
    }));

  if (current.length === 0) return { priced: [], budgetCents, attempt };
  while (current.length > 0) {
    budgetCents = budgetForPlan({
      holdCents,
      budgetCents: mandate.budgetCents,
      commitments: state.commitments,
      mandateLotNumbers: mandateLotNumbers(mandate),
      planLotNumbers: new Set(current.map((lot) => lot.lot.number)),
    });
    // A budget of zero or less fits nothing; never pass it on, since the clamp would read it as "none".
    if (budgetCents <= 0) return { priced: null, budgetCents, attempt };
    const caps = allocatorCaps(current, budgetCents);
    const intent: PlanIntent = {
      tool: "propose_change",
      budgetCents,
      items: current.map((lot) => ({ lotNumber: lot.lot.number, priority: lot.priority, capCents: caps.get(lot.lot.number) ?? null })),
    };
    const check = checkPlan(intent, state);
    attempt ??= new Map((check.allocation?.items ?? []).map((item) => [item.lot.number, item.maxCents]));
    if (check.issues.length === 0 && check.allocation) return { priced: toPriced(check.allocation.items), budgetCents, attempt };

    const clamped = clampPlan(intent, state);
    if (!clamped.allocation) return { priced: null, budgetCents, attempt };
    adjustments.push(...clamped.adjustments);
    const kept = new Set(clamped.allocation.items.map((item) => item.lot.number));
    if (kept.size === current.length) return { priced: toPriced(clamped.allocation.items), budgetCents, attempt };
    current = current.filter((lot) => kept.has(lot.lot.number));
  }
  return { priced: null, budgetCents, attempt };
}

/** Keeps each live lot at its maximum or lowers it to the decision's ceiling; drops what cannot stay. */
function lowerOrDrop(
  resolved: readonly ResolvedLot[],
  live: ReadonlyMap<string, AutopilotLimit>,
  adjustments: ValidationIssue[],
): PricedLot[] {
  const priced: PricedLot[] = [];
  for (const lot of [...resolved].sort((a, b) => a.priority - b.priority || a.lot.number - b.lot.number)) {
    const current = live.get(lot.lot.id)?.maxCents ?? 0;
    const maxCents = minCap(current, lot.guestCap, lot.ceiling) ?? current;
    const floorCents = minimumMaxCents(lot.lot);
    if (maxCents < floorCents) {
      adjustments.push(
        issue("max_below_next_minimum", `Left out ${lotLabel(lot.lot)}: ${formatUsd(maxCents)} is below its floor of ${formatUsd(floorCents)}.`, {
          lot: lot.lot,
          amountCents: maxCents,
          limitCents: floorCents,
        }),
      );
      continue;
    }
    priced.push({
      lotId: lot.lot.id,
      lotNumber: lot.lot.number,
      shortTitle: lot.lot.shortTitle,
      priority: lot.priority,
      capCents: minCap(lot.guestCap, lot.ceiling),
      floorCents,
      maxCents,
    });
  }
  return priced;
}

export interface RaiseBounds {
  /** What the plan needs in all: commitments outside it plus each lot's cap or floor. */
  neededCents: number;
  minCents: number;
  maxCents: number;
}

export interface RaisePlan {
  bounds: RaiseBounds;
  /** The plan as it would be priced at the highest raise the guest's budget allows. */
  atCeiling: CheckedChange;
}

export type RaiseCheck = { ok: true; plan: RaisePlan } | { ok: false; issues: ValidationIssue[]; attempt: Map<number, number> | null };

/** What P needs in all at the least: the hold must cover this for the plan to fit (§4.1 item 4). */
export function neededCents(plan: readonly PricedLot[], state: GlimState): number {
  const inPlan = new Set(plan.map((lot) => lot.lotNumber));
  const outside = state.commitments
    .filter((commitment) => !inPlan.has(commitment.lotNumber))
    .reduce((sum, commitment) => sum + commitment.withoutGlimCents, 0);
  return outside + plan.reduce((sum, lot) => sum + (lot.capCents ?? lot.floorCents), 0);
}

/**
 * R10: Glim may prepare a raise only when the guest named a budget above their bidding power,
 * no raise is pending, fewer than two were prepared, and the plan fits only with more bidding
 * power: X must lie in [max(needed, hold + $1), min(budget, the event's hold maximum)].
 */
export function checkRaise(lots: readonly AutopilotDecisionLot[], context: AutopilotContext): RaiseCheck {
  const { state, mandate } = context;
  const hold = state.holdCents;
  const reject = (reason: RejectReason, message: string): RaiseCheck => ({ ok: false, issues: [issue(reason, message)], attempt: null });
  if (hold === null) return reject("no_hold", "Bidding power isn't set, so there is nothing to raise.");
  if (mandate.budgetCents === null || mandate.budgetCents <= hold) {
    return reject("raise_not_allowed", "A raise needs a budget the guest named above their bidding power.");
  }
  if (context.pendingRaise && !context.pendingRaise.approved) {
    return reject("raise_pending", "A raise is already waiting for the guest's approval.");
  }
  if (context.raisesPrepared >= MAX_RAISES_PER_PADDLE) {
    return reject("raise_limit_reached", `Glim already prepared ${MAX_RAISES_PER_PADDLE} raises for this guest.`);
  }
  const ceiling = Math.min(mandate.budgetCents, state.event.holdMaxCents);
  if (ceiling <= hold) return reject("raise_not_allowed", "Bidding power is already at the most the guest's budget or the event allows.");

  const now = checkChange(lots, context);
  if (now.ok && !changeIsNoop(now.change)) return reject("raise_not_allowed", "This plan fits without a raise.");
  const atCeiling = checkChange(lots, context, { holdCents: ceiling });
  if (!atCeiling.ok) return { ok: false, issues: atCeiling.issues, attempt: atCeiling.attempt };
  if (changeIsNoop(atCeiling.change)) return reject("raise_not_allowed", "The plan would not change.");
  const needed = neededCents(atCeiling.plan, state);
  const minCents = Math.max(needed, hold + WHOLE_DOLLAR);
  if (minCents > ceiling) return reject("raise_not_allowed", "The plan needs more than the guest's budget allows.");
  return { ok: true, plan: { bounds: { neededCents: needed, minCents, maxCents: ceiling }, atCeiling } };
}

/**
 * The raise to store: the decision's amount when it lies in range, else the smallest event preset
 * in range, else the minimum rounded up to $10 (within the maximum).
 */
export function raiseAmount(
  requestedCents: number | null,
  bounds: RaiseBounds,
  presetsCents: readonly number[],
): { amountCents: number; adjusted: boolean } {
  const inRange = (cents: number) => cents >= bounds.minCents && cents <= bounds.maxCents;
  if (requestedCents !== null && inRange(requestedCents) && requestedCents % WHOLE_DOLLAR === 0) {
    return { amountCents: requestedCents, adjusted: false };
  }
  const preset = [...presetsCents].sort((a, b) => a - b).find(inRange);
  const rounded = Math.min(bounds.maxCents, Math.ceil(bounds.minCents / TEN_DOLLARS) * TEN_DOLLARS);
  return { amountCents: preset ?? rounded, adjusted: requestedCents !== null };
}

export type DecisionCheck =
  | { ok: true; action: "keep"; adjusted: false; adjustments: ValidationIssue[] }
  | ({ action: "change" } & CheckedChange)
  | {
      ok: true;
      action: "prepare_raise";
      plan: RaisePlan;
      amountCents: number;
      adjusted: boolean;
      adjustments: ValidationIssue[];
    }
  | ({ action: "rejected" } & { ok: false; issues: ValidationIssue[] });

/**
 * R0 is parseDecision. R1–R10 here, on the run's fresh read. A change that changes no limit,
 * such as a reordering, counts as keep.
 */
export function checkDecision(decision: AutopilotDecision, context: AutopilotContext): DecisionCheck {
  if (decision.action === "keep") return { ok: true, action: "keep", adjusted: false, adjustments: [] };
  if (decision.action === "change") {
    const check = checkChange(decision.lots, context);
    if (!check.ok) return { ok: false, action: "rejected", issues: check.issues };
    if (changeIsNoop(check.change)) return { ok: true, action: "keep", adjusted: false, adjustments: [] };
    return { action: "change", ...check };
  }
  const raise = checkRaise(decision.lots, context);
  if (!raise.ok) return { ok: false, action: "rejected", issues: raise.issues };
  const amount = raiseAmount(decision.raiseToCents, raise.plan.bounds, context.state.event.holdPresetsCents);
  const adjustments = [...raise.plan.atCeiling.adjustments];
  if (amount.adjusted) {
    adjustments.push(
      issue("raise_amount_adjusted", `The raise was set to ${formatUsd(amount.amountCents)}, within ${formatUsd(raise.plan.bounds.minCents)} to ${formatUsd(raise.plan.bounds.maxCents)}.`, {
        amountCents: decision.raiseToCents,
        limitCents: amount.amountCents,
      }),
    );
  }
  return {
    ok: true,
    action: "prepare_raise",
    plan: raise.plan,
    amountCents: amount.amountCents,
    adjusted: adjustments.length > 0,
    adjustments,
  };
}

/** The engine call a change becomes: createLimits for new and changed limits, removals for the rest. */
export function toEngineChange(change: AutopilotChange): { items: { lotId: string; maxCents: number }[]; removeLotIds: string[] } {
  return {
    items: change.set.map((lot) => ({ lotId: lot.lotId, maxCents: lot.maxCents })),
    removeLotIds: [...change.removeLotIds],
  };
}
