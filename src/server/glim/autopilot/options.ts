/**
 * What is possible right now, worked out by code before any model call
 * (docs/planning/glim-autopilot.md §4.1). Every option is a decision that checkChange accepted,
 * so the list is exactly what Fairhold would apply. The model chooses among these and keep; the
 * rule (rule.ts) takes the first safe add or top-up.
 */
import { minimumMaxCents } from "../allocator";
import { guestCapCents, lotBlocker, mandateRank, rankedMandateLots } from "../mandate";
import type { GlimLotState } from "../types";

import {
  changeIsNoop,
  type AutopilotChange,
  type AutopilotContext,
  type AutopilotDecisionLot,
  type AutopilotLimit,
} from "./types";
import {
  checkChange,
  checkRaise,
  liveGlimLimits,
  lotAvailability,
  type CheckedChange,
  type RaiseBounds,
} from "./validate";

export type OptionKind = "add" | "priority" | "top_up" | "raise";

export interface AutopilotOption {
  kind: OptionKind;
  /** The lot the move is for. */
  lotId: string;
  lotNumber: number;
  /** The decision that makes this move; the rule and a pending raise send it as is. */
  lots: AutopilotDecisionLot[];
  /** The checked plan; for a raise, as priced at the highest raise the budget allows. */
  check: CheckedChange;
  /** Some live lot gets a lower maximum or ends. */
  lowersLive: boolean;
  raise: RaiseBounds | null;
}

/** A move for an allowed lot that does not fit, for the brief's "Does not fit" lines. */
export interface MissedMove {
  lotId: string;
  lotNumber: number;
  /** The lowest maximum that could bid there: the next minimum, or the guest's own bid. */
  floorCents: number;
  /** The guest's cap there, when it is below the floor. */
  capBelowFloorCents: number | null;
  /** What the lot would get: with lower-ranked live lots at their floors when that was tried. */
  freeCents: number;
  lowered: { lotId: string; lotNumber: number; toCents: number; ownBid: boolean }[];
}

export interface AutopilotOptions {
  options: AutopilotOption[];
  missed: MissedMove[];
}

function lowersLive(change: AutopilotChange): boolean {
  const after = new Map(change.after.map((lot) => [lot.lotId, lot.maxCents]));
  return change.before.some((lot) => (after.get(lot.lotId) ?? 0) < lot.maxCents);
}

function gainOn(change: AutopilotChange, lotId: string): number {
  const before = change.before.find((lot) => lot.lotId === lotId)?.maxCents ?? 0;
  const after = change.after.find((lot) => lot.lotId === lotId)?.maxCents ?? 0;
  return after - before;
}

interface Move {
  kind: "add" | "priority";
  lots: AutopilotDecisionLot[];
  lowered: MissedMove["lowered"];
}

export function computeOptions(context: AutopilotContext): AutopilotOptions {
  const { state, mandate } = context;
  const live = liveGlimLimits(context);
  const facts = lotAvailability(context);
  const lotsById = new Map(state.lots.map((lot) => [lot.id, lot]));
  const rank = (lotId: string) => mandateRank(mandate, lotId) ?? Number.POSITIVE_INFINITY;
  // Live lots outside the mandate cannot be kept by autopilot; they never appear in a decision.
  const liveInMandate = [...live.values()]
    .filter((limit) => Number.isFinite(rank(limit.lotId)))
    .sort((a, b) => rank(a.lotId) - rank(b.lotId) || a.lotNumber - b.lotNumber);
  const asDecision = (limit: AutopilotLimit, maxCents: number | null = null): AutopilotDecisionLot => ({
    lotNumber: limit.lotNumber,
    priority: rank(limit.lotId),
    maxCents,
  });
  const floorOf = (limit: AutopilotLimit): number => {
    const lot = lotsById.get(limit.lotId);
    return lot ? minimumMaxCents(lot) : limit.maxCents;
  };

  const options: AutopilotOption[] = [];
  const missed: MissedMove[] = [];
  const unfitted: { lot: GlimLotState; moves: Move[] }[] = [];

  for (const mandated of rankedMandateLots(mandate)) {
    const lot = lotsById.get(mandated.lotId);
    if (!lot || lotBlocker(lot, mandate, facts) !== null) continue;
    const isLive = live.has(lot.id);
    const target: AutopilotDecisionLot = { lotNumber: lot.number, priority: mandated.rank, maxCents: null };

    const moves: Move[] = [];
    if (!isLive) {
      moves.push({ kind: "add", lots: [...liveInMandate.map((limit) => asDecision(limit)), target], lowered: [] });
    }
    const lowerRanked = liveInMandate.filter((limit) => limit.lotId !== lot.id && rank(limit.lotId) > mandated.rank);
    if (lowerRanked.length > 0) {
      const lowered = lowerRanked.map((limit) => {
        const toCents = Math.min(floorOf(limit), limit.maxCents);
        const ownBid = lotsById.get(limit.lotId)?.guestStatus === "winning";
        return { lotId: limit.lotId, lotNumber: limit.lotNumber, toCents, ownBid };
      });
      const lots = liveInMandate.map((limit) =>
        asDecision(limit, lowered.find((entry) => entry.lotId === limit.lotId)?.toCents ?? null),
      );
      moves.push({ kind: "priority", lots: isLive ? lots : [...lots, target], lowered });
    }
    if (moves.length === 0) continue;

    let fitted = false;
    for (const move of moves) {
      // A priority call is offered only where adding the lot alone does not fit, or it is live.
      if (move.kind === "priority" && fitted) continue;
      const check = checkChange(move.lots, context);
      if (!check.ok || changeIsNoop(check.change) || gainOn(check.change, lot.id) <= 0) continue;
      options.push({
        kind: move.kind,
        lotId: lot.id,
        lotNumber: lot.number,
        lots: move.lots,
        check,
        lowersLive: lowersLive(check.change),
        raise: null,
      });
      fitted = true;
    }
    if (!fitted) {
      unfitted.push({ lot, moves });
      missed.push(describeMiss(lot, moves, context));
    }
  }

  // Top up: the live lots re-allocated, when the budget now gives one of them more.
  if (liveInMandate.some((limit) => guestCapCents(mandate, limit.lotId) === null)) {
    const lots = liveInMandate.map((limit) => asDecision(limit));
    const check = checkChange(lots, context);
    if (check.ok && !changeIsNoop(check.change)) {
      const gainer = [...check.change.after]
        .map((lot) => ({ lot, gain: gainOn(check.change, lot.lotId) }))
        .filter((entry) => entry.gain > 0)
        .sort((a, b) => b.gain - a.gain || rank(a.lot.lotId) - rank(b.lot.lotId))[0];
      if (gainer) {
        options.push({
          kind: "top_up",
          lotId: gainer.lot.lotId,
          lotNumber: gainer.lot.lotNumber,
          lots,
          check,
          lowersLive: lowersLive(check.change),
          raise: null,
        });
      }
    }
  }

  // Raise: for the highest-ranked move that fails only on the hold (B above it).
  const raise = raiseOption(unfitted, context);
  if (raise) options.push(raise);
  return { options, missed };
}

function raiseOption(unfitted: readonly { lot: GlimLotState; moves: Move[] }[], context: AutopilotContext): AutopilotOption | null {
  const { mandate, state } = context;
  if (state.holdCents === null || mandate.budgetCents === null || mandate.budgetCents <= state.holdCents) return null;
  for (const { lot, moves } of unfitted) {
    for (const move of moves) {
      const raise = checkRaise(move.lots, context);
      if (!raise.ok) continue;
      if (gainOn(raise.plan.atCeiling.change, lot.id) <= 0) continue;
      return {
        kind: "raise",
        lotId: lot.id,
        lotNumber: lot.number,
        lots: move.lots,
        check: raise.plan.atCeiling,
        lowersLive: lowersLive(raise.plan.atCeiling.change),
        raise: raise.plan.bounds,
      };
    }
  }
  return null;
}

function describeMiss(lot: GlimLotState, moves: readonly Move[], context: AutopilotContext): MissedMove {
  const floorCents = minimumMaxCents(lot);
  const cap = guestCapCents(context.mandate, lot.id);
  const last = moves.at(-1);
  let freeCents = 0;
  if (last) {
    const check = checkChange(last.lots, context);
    const attempt = check.ok ? null : check.attempt;
    freeCents = attempt?.get(lot.number) ?? (check.ok ? (check.change.after.find((entry) => entry.lotId === lot.id)?.maxCents ?? 0) : 0);
  }
  return {
    lotId: lot.id,
    lotNumber: lot.number,
    floorCents,
    capBelowFloorCents: cap !== null && cap < floorCents ? cap : null,
    freeCents: Math.max(0, freeCents),
    lowered: last?.kind === "priority" ? last.lowered : [],
  };
}

/** The lots the options are for, sorted: the last part of the recorded-fixture key. */
export function optionLotNumbers(options: readonly AutopilotOption[]): number[] {
  return [...new Set(options.map((option) => option.lotNumber))].sort((a, b) => a - b);
}
