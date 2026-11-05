/**
 * The rules every proposal must pass before a guest sees it: only open lots, every maximum at or
 * above the lot's next minimum bid, and maximums adding up to no more than the smaller of the
 * budget and the available hold. A failed proposal goes back to the model once; after that
 * clampPlan repairs it by only ever lowering or dropping. Every broken rule is a ValidationIssue,
 * which becomes a glim_actions record.
 */
import {
  allocatePlan,
  availableForPlan,
  byPriority,
  minimumMaxCents,
  type Allocation,
  type PlanLot,
} from "./allocator";
import { formatUsd } from "./money";
import { isOpenForBids, lotLabel } from "./prompt";
import type {
  GlimActionRecord,
  GlimLotState,
  GlimState,
  HoldSuggestionIntent,
  PlanIntent,
  RejectReason,
  ValidationIssue,
} from "./types";

export interface PlanCheck {
  issues: ValidationIssue[];
  /** The allocation of the lots that passed the item checks, or null when none did. */
  allocation: Allocation | null;
}

export interface ClampedPlan {
  intent: PlanIntent;
  /** A plan that passes checkPlan, or null when nothing could be kept. */
  allocation: Allocation | null;
  /** What was lowered or dropped, and why. */
  adjustments: ValidationIssue[];
}

function issue(
  reason: RejectReason,
  message: string,
  fields: { lot?: GlimLotState; lotNumber?: number; amountCents?: number | null; limitCents?: number | null } = {},
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

function floorPhrase(lot: GlimLotState): string {
  const floor = formatUsd(minimumMaxCents(lot));
  return lot.guestStatus === "winning" ? `the guest's winning bid of ${floor}` : `the next minimum bid of ${floor}`;
}

const noHoldIssue = (): ValidationIssue =>
  issue("no_hold", "Bidding power isn't set yet, so there is nothing to plan within.");

interface ResolvedItems {
  planLots: PlanLot[];
  issues: ValidationIssue[];
}

/** Matches intent items to open lots; mode "repair" fixes or drops what "check" only reports. */
function resolveItems(intent: PlanIntent, state: GlimState, mode: "check" | "repair"): ResolvedItems {
  const lotsByNumber = new Map(state.lots.map((lot) => [lot.number, lot]));
  const seen = new Set<number>();
  const planLots: PlanLot[] = [];
  const issues: ValidationIssue[] = [];

  for (const item of intent.items) {
    const lot = lotsByNumber.get(item.lotNumber);
    if (seen.has(item.lotNumber)) {
      const label = lot ? lotLabel(lot) : `Lot ${item.lotNumber}`;
      issues.push(issue("duplicate_lot", `${label} appears more than once.`, { lot, lotNumber: item.lotNumber }));
      continue;
    }
    seen.add(item.lotNumber);
    if (!lot) {
      issues.push(issue("unknown_lot", `There is no Lot ${item.lotNumber} in this auction.`, { lotNumber: item.lotNumber }));
      continue;
    }
    if (!isOpenForBids(lot, state.now)) {
      issues.push(issue("lot_not_open", `${lotLabel(lot)} is closed to bids.`, { lot }));
      continue;
    }
    if (item.capCents !== null && item.capCents <= 0) {
      issues.push(
        issue("invalid_amount", `${lotLabel(lot)} has a cap of ${formatUsd(item.capCents)}; a cap must be at least $1.`, {
          lot,
          amountCents: item.capCents,
        }),
      );
      continue;
    }
    let priority = item.priority;
    if (!Number.isInteger(priority) || priority < 1) {
      issues.push(issue("invalid_priority", `${lotLabel(lot)} has priority ${priority}; priorities start at 1.`, { lot }));
      if (mode === "check") continue;
      priority = 1;
    }
    planLots.push({ lot, priority, capCents: item.capCents });
  }
  return { planLots, issues };
}

function belowFloorMessage(item: { lot: GlimLotState; capCents: number | null; maxCents: number }): string {
  if (item.capCents !== null) {
    return `${lotLabel(item.lot)}: the cap of ${formatUsd(item.capCents)} is below ${floorPhrase(item.lot)}.`;
  }
  return `${lotLabel(item.lot)}: the budget leaves ${formatUsd(item.maxCents)} for it, below ${floorPhrase(item.lot)}.`;
}

export function checkPlan(intent: PlanIntent, state: GlimState): PlanCheck {
  if (state.holdCents === null) return { issues: [noHoldIssue()], allocation: null };

  const issues: ValidationIssue[] = [];
  if (intent.items.length === 0) issues.push(issue("empty_plan", "The plan has no lots."));
  const budgetIsValid = intent.budgetCents === null || intent.budgetCents > 0;
  if (!budgetIsValid) {
    issues.push(
      issue("invalid_amount", "The budget must be at least $1.", { amountCents: intent.budgetCents }),
    );
  }

  const resolved = resolveItems(intent, state, "check");
  issues.push(...resolved.issues);
  if (resolved.planLots.length === 0) return { issues, allocation: null };

  const allocation = allocatePlan({
    holdCents: state.holdCents,
    budgetCents: budgetIsValid ? intent.budgetCents : null,
    commitments: state.commitments,
    planLots: resolved.planLots,
  });

  if (allocation.budgetCents !== null && allocation.budgetCents > allocation.availableCents) {
    issues.push(
      issue(
        "budget_over_available",
        `The budget of ${formatUsd(allocation.budgetCents)} is above the ${formatUsd(allocation.availableCents)} of bidding power available for this plan.`,
        { amountCents: allocation.budgetCents, limitCents: allocation.availableCents },
      ),
    );
  }
  for (const item of allocation.items) {
    if (item.maxCents < item.floorCents) {
      issues.push(
        issue("max_below_next_minimum", belowFloorMessage(item), {
          lot: item.lot,
          amountCents: item.maxCents,
          limitCents: item.floorCents,
        }),
      );
    }
  }
  if (allocation.totalCents > allocation.limitCents) {
    issues.push(
      issue(
        "total_over_limit",
        `The maximums add up to ${formatUsd(allocation.totalCents)}, above the ${formatUsd(allocation.limitCents)} this plan can use.`,
        { amountCents: allocation.totalCents, limitCents: allocation.limitCents },
      ),
    );
  }
  return { issues, allocation };
}

/**
 * Repairs a proposal that failed twice. It only lowers caps and the budget or drops lots, never
 * raises anything the guest said, so the result is always within what they asked for.
 */
export function clampPlan(intent: PlanIntent, state: GlimState): ClampedPlan {
  if (state.holdCents === null) return { intent, allocation: null, adjustments: [noHoldIssue()] };
  const holdCents = state.holdCents;

  const resolved = resolveItems(intent, state, "repair");
  const adjustments = [...resolved.issues];
  let budgetCents = intent.budgetCents !== null && intent.budgetCents > 0 ? intent.budgetCents : null;
  if (intent.budgetCents !== null && budgetCents === null) {
    adjustments.push(
      issue("invalid_amount", "The budget must be at least $1; the plan uses the available bidding power.", {
        amountCents: intent.budgetCents,
      }),
    );
  }

  let remaining = [...resolved.planLots].sort(byPriority);
  const drop = (item: PlanLot, dropped: ValidationIssue) => {
    adjustments.push(dropped);
    remaining = remaining.filter((candidate) => candidate.lot.number !== item.lot.number);
  };

  while (remaining.length > 0) {
    const available = availableForPlan(holdCents, state.commitments, new Set(remaining.map((item) => item.lot.number)));
    const limit = Math.max(0, budgetCents === null ? available : Math.min(budgetCents, available));

    const unaffordable = remaining.find((item) => minimumMaxCents(item.lot) > limit);
    if (unaffordable) {
      drop(
        unaffordable,
        issue(
          "max_below_next_minimum",
          `Left out ${lotLabel(unaffordable.lot)}: ${floorPhrase(unaffordable.lot)} is above the ${formatUsd(limit)} this plan can use.`,
          { lot: unaffordable.lot, amountCents: limit, limitCents: minimumMaxCents(unaffordable.lot) },
        ),
      );
      continue;
    }
    const capTooLow = remaining.find((item) => item.capCents !== null && item.capCents < minimumMaxCents(item.lot));
    if (capTooLow && capTooLow.capCents !== null) {
      drop(
        capTooLow,
        issue("max_below_next_minimum", `Left out ${belowFloorMessage({ ...capTooLow, maxCents: capTooLow.capCents })}`, {
          lot: capTooLow.lot,
          amountCents: capTooLow.capCents,
          limitCents: minimumMaxCents(capTooLow.lot),
        }),
      );
      continue;
    }
    const fitted = remaining.map((item) =>
      item.capCents !== null && item.capCents > limit ? { ...item, capCents: limit } : item,
    );
    const neededCents = fitted.reduce((sum, item) => sum + (item.capCents ?? minimumMaxCents(item.lot)), 0);
    const lowest = fitted.at(-1);
    if (neededCents > limit && lowest) {
      drop(
        lowest,
        issue(
          "total_over_limit",
          `Left out ${lotLabel(lowest.lot)}, the lowest priority: the lots need ${formatUsd(neededCents)}, above the ${formatUsd(limit)} this plan can use.`,
          { lot: lowest.lot, amountCents: neededCents, limitCents: limit },
        ),
      );
      continue;
    }

    for (const item of fitted) {
      const original = remaining.find((candidate) => candidate.lot.number === item.lot.number);
      if (original && original.capCents !== null && item.capCents !== null && item.capCents < original.capCents) {
        adjustments.push(
          issue(
            "cap_above_limit",
            `${lotLabel(item.lot)}: the cap of ${formatUsd(original.capCents)} was lowered to ${formatUsd(item.capCents)}, all this plan can use.`,
            { lot: item.lot, amountCents: original.capCents, limitCents: item.capCents },
          ),
        );
      }
    }
    if (budgetCents !== null && budgetCents > available) {
      adjustments.push(
        issue(
          "budget_over_available",
          `The budget of ${formatUsd(budgetCents)} was lowered to the ${formatUsd(available)} of bidding power available.`,
          { amountCents: budgetCents, limitCents: available },
        ),
      );
      budgetCents = available;
    }
    remaining = fitted;
    break;
  }

  const clamped: PlanIntent = {
    tool: intent.tool,
    budgetCents,
    items: remaining.map((item) => ({ lotNumber: item.lot.number, priority: item.priority, capCents: item.capCents })),
  };
  if (clamped.items.length === 0) return { intent: clamped, allocation: null, adjustments };

  // Fails closed: a repair that still breaks a rule (a bug) yields no plan rather than a bad one.
  const recheck = checkPlan(clamped, state);
  if (recheck.issues.length > 0 || recheck.allocation === null) {
    return { intent: clamped, allocation: null, adjustments: [...adjustments, ...recheck.issues] };
  }
  return { intent: clamped, allocation: recheck.allocation, adjustments };
}

export function checkHoldSuggestion(intent: HoldSuggestionIntent, state: GlimState): ValidationIssue[] {
  const { holdMinCents, holdMaxCents } = state.event;
  const issues: ValidationIssue[] = [];
  if (state.holdCents !== null && state.holdCents >= holdMaxCents) {
    issues.push(
      issue("hold_at_maximum", `Bidding power is already at this event's maximum of ${formatUsd(holdMaxCents)}.`, {
        amountCents: intent.amountCents,
        limitCents: holdMaxCents,
      }),
    );
    return issues;
  }
  if (state.holdCents !== null && intent.amountCents <= state.holdCents) {
    issues.push(
      issue(
        "hold_not_higher",
        `${formatUsd(intent.amountCents)} is not above the current bidding power of ${formatUsd(state.holdCents)}.`,
        { amountCents: intent.amountCents, limitCents: state.holdCents },
      ),
    );
  }
  if (intent.amountCents < holdMinCents || intent.amountCents > holdMaxCents) {
    issues.push(
      issue(
        "hold_out_of_range",
        `${formatUsd(intent.amountCents)} is outside this event's range of ${formatUsd(holdMinCents)} to ${formatUsd(holdMaxCents)}.`,
        { amountCents: intent.amountCents, limitCents: intent.amountCents > holdMaxCents ? holdMaxCents : holdMinCents },
      ),
    );
  }
  return issues;
}

/**
 * Moves a suggestion into the allowed range: one that isn't a raise becomes the next preset above
 * the current hold. Null when bidding power cannot go any higher.
 */
export function clampHoldSuggestion(
  intent: HoldSuggestionIntent,
  state: GlimState,
): { amountCents: number | null; adjustments: ValidationIssue[] } {
  const adjustments = checkHoldSuggestion(intent, state);
  const { holdMinCents, holdMaxCents, holdPresetsCents } = state.event;
  const holdCents = state.holdCents;
  if (holdCents !== null && holdCents >= holdMaxCents) return { amountCents: null, adjustments };
  let amountCents = intent.amountCents;
  if (holdCents !== null && amountCents <= holdCents) {
    amountCents = [...holdPresetsCents].sort((a, b) => a - b).find((preset) => preset > holdCents) ?? holdMaxCents;
  }
  return { amountCents: Math.min(holdMaxCents, Math.max(holdMinCents, amountCents)), adjustments };
}

/** The tool_result text a rejected proposal goes back to the model with. */
export function describeIssuesForModel(issues: readonly ValidationIssue[]): string {
  return [
    "Fairhold did not show this proposal to the guest because it breaks these rules:",
    ...issues.map((rejected) => `- ${rejected.message}`),
    "Propose once more within these limits, or tell the guest in a sentence what doesn't fit and offer to raise their bidding power if that would help.",
  ].join("\n");
}

export function toGlimActionRecords(
  issues: readonly ValidationIssue[],
  context: { paddleId: string; holdCents: number | null; planId?: string | null },
): GlimActionRecord[] {
  return issues.map((rejected) => ({
    paddleId: context.paddleId,
    planId: context.planId ?? null,
    lotId: rejected.lotId,
    kind: "proposal_rejected",
    amountCents: rejected.amountCents,
    limitCents: rejected.limitCents,
    holdCentsAtTime: context.holdCents,
    decision: "rejected",
    rejectReason: rejected.reason,
    message: rejected.message,
    chip: "none",
    triggerBidId: null,
  }));
}
