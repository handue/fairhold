/**
 * Deterministic allocation: the model states intent (budget, lots, priorities, optional caps) and
 * this module turns it into one maximum per lot. Explicit caps are honored first, lower
 * priorities without a cap get their minimum, and the rest goes to the top priority. It never
 * decides whether a plan is acceptable; validator.ts checks its output independently.
 */
import type { GlimCommitment, GlimLotState } from "./types";

export interface PlanLot {
  lot: GlimLotState;
  priority: number;
  capCents: number | null;
}

export interface AllocatedItem extends PlanLot {
  floorCents: number;
  maxCents: number;
}

export interface Allocation {
  holdCents: number;
  /** The hold minus the commitments on lots outside the plan. */
  availableCents: number;
  /** The guest's budget as proposed, or null when they gave none. */
  budgetCents: number | null;
  /** What the maxima may add up to: the smaller of the budget and the available hold. */
  limitCents: number;
  items: AllocatedItem[];
  totalCents: number;
}

const WHOLE_DOLLAR = 100;

/**
 * The lowest useful maximum for a lot: its next minimum bid, so the limit can place at least one
 * bid. When the guest already leads, that bid stands and a maximum equal to it is valid; this is
 * what lets a lot sitting at its limit stay unchanged through a plan change. The engine's
 * createLimits accepts the same floor (minimumLimitCents in src/server/engine/rules.ts).
 */
export function minimumMaxCents(lot: GlimLotState): number {
  if (lot.guestStatus === "winning" && lot.currentBidCents !== null) return lot.currentBidCents;
  return lot.nextMinimumCents;
}

/**
 * What a plan over these lots may commit: the hold minus every commitment outside the plan. Lots
 * inside the plan are excluded because the plan's maximum replaces their commitment, and Glim
 * limits outside it count only the bids that would stand once the limit is gone.
 */
export function availableForPlan(
  holdCents: number,
  commitments: readonly GlimCommitment[],
  planLotNumbers: ReadonlySet<number>,
): number {
  const outside = commitments
    .filter((commitment) => !planLotNumbers.has(commitment.lotNumber))
    .reduce((sum, commitment) => sum + commitment.withoutGlimCents, 0);
  return holdCents - outside;
}

export function byPriority(a: PlanLot, b: PlanLot): number {
  return a.priority - b.priority || a.lot.number - b.lot.number;
}

/** Spreads limitCents over the lots. The result can break the rules; the validator says how. */
export function distributeMaxima(planLots: readonly PlanLot[], limitCents: number): AllocatedItem[] {
  const ordered = [...planLots].sort(byPriority);
  const uncapped = ordered.filter((item) => item.capCents === null);
  const topPriority = uncapped.length > 0 ? Math.min(...uncapped.map((item) => item.priority)) : null;
  const isTop = (item: PlanLot) => item.capCents === null && item.priority === topPriority;

  const allocated = new Map<PlanLot, number>();
  let fixedCents = 0;
  for (const item of ordered) {
    if (isTop(item)) continue;
    const maxCents = item.capCents ?? minimumMaxCents(item.lot);
    allocated.set(item, maxCents);
    fixedCents += maxCents;
  }

  const top = ordered.filter(isTop);
  if (top.length > 0) {
    const floors = top.reduce((sum, item) => sum + minimumMaxCents(item.lot), 0);
    const surplus = limitCents - fixedCents - floors;
    // Equal shares in whole dollars; the odd cents and dollars go to the first lot in order.
    const share = Math.trunc(surplus / top.length / WHOLE_DOLLAR) * WHOLE_DOLLAR;
    const leftover = surplus - share * top.length;
    top.forEach((item, index) => {
      const maxCents = minimumMaxCents(item.lot) + share + (index === 0 ? leftover : 0);
      allocated.set(item, Math.max(0, maxCents));
    });
  }

  return ordered.map((item) => ({
    ...item,
    floorCents: minimumMaxCents(item.lot),
    maxCents: allocated.get(item) ?? 0,
  }));
}

export function allocatePlan(input: {
  holdCents: number;
  budgetCents: number | null;
  commitments: readonly GlimCommitment[];
  planLots: readonly PlanLot[];
}): Allocation {
  const lotNumbers = new Set(input.planLots.map((item) => item.lot.number));
  const availableCents = availableForPlan(input.holdCents, input.commitments, lotNumbers);
  const limitCents = Math.max(
    0,
    input.budgetCents === null ? availableCents : Math.min(input.budgetCents, availableCents),
  );
  const items = distributeMaxima(input.planLots, limitCents);
  return {
    holdCents: input.holdCents,
    availableCents,
    budgetCents: input.budgetCents,
    limitCents,
    items,
    totalCents: items.reduce((sum, item) => sum + item.maxCents, 0),
  };
}
