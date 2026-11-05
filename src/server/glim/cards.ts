/**
 * What a validated proposal becomes: the card the guest reviews (07's plan card, or a raise
 * bidding power button) and the tool result the model reads back. Both are written by code from
 * validated numbers, so every amount on them is exact.
 */
import type { Allocation } from "./allocator";
import { formatUsd } from "./money";
import { lotLabel } from "./prompt";
import type { GlimLotState, GlimState, PlanToolName, ValidationIssue } from "./types";

export interface PlanCardItem {
  lotId: string;
  lotNumber: number;
  shortTitle: string;
  priority: number;
  maxCents: number;
  capCents: number | null;
  /** The line under each lot on 07's card, such as "Winning at $320" or "Current bid $85". */
  statusText: string;
}

export interface PlanCard {
  type: "plan";
  /** "change" when confirming it would replace an active or paused plan. */
  kind: "new" | "change";
  /** The plan this one supersedes once confirmed (a proposed, active or paused plan). */
  replacesPlanId: string | null;
  tool: PlanToolName;
  budgetCents: number;
  totalCents: number;
  holdCents: number;
  availableCents: number;
  /** In priority order; 07's allocation bar is each maximum's share of the budget. */
  items: PlanCardItem[];
  /** True when code lowered or dropped something after the model's one retry. */
  adjusted: boolean;
  notes: string[];
}

export interface HoldCard {
  type: "hold";
  /** The suggested total bidding power, preselected on 09. */
  amountCents: number;
  currentHoldCents: number | null;
  lotNumbers: number[];
  notes: string[];
}

export type GlimCard = PlanCard | HoldCard;

export function planItemStatusText(lot: GlimLotState): string {
  if (lot.guestStatus === "winning" && lot.currentBidCents !== null) return `Winning at ${formatUsd(lot.currentBidCents)}`;
  if (lot.currentBidCents !== null) return `Current bid ${formatUsd(lot.currentBidCents)}`;
  return `Opening bid ${formatUsd(lot.nextMinimumCents)}`;
}

export function buildPlanCard(input: {
  tool: PlanToolName;
  allocation: Allocation;
  state: GlimState;
  adjustments: readonly ValidationIssue[];
}): PlanCard {
  const { allocation, state } = input;
  const replacesActive = state.plan !== null && state.plan.status !== "proposed";
  return {
    type: "plan",
    kind: replacesActive ? "change" : "new",
    replacesPlanId: state.plan?.id ?? null,
    tool: input.tool,
    budgetCents: allocation.budgetCents ?? allocation.totalCents,
    totalCents: allocation.totalCents,
    holdCents: allocation.holdCents,
    availableCents: allocation.availableCents,
    items: allocation.items.map((item) => ({
      lotId: item.lot.id,
      lotNumber: item.lot.number,
      shortTitle: item.lot.shortTitle,
      priority: item.priority,
      maxCents: item.maxCents,
      capCents: item.capCents,
      statusText: planItemStatusText(item.lot),
    })),
    adjusted: input.adjustments.length > 0,
    notes: input.adjustments.map((adjustment) => adjustment.message),
  };
}

export function buildHoldCard(input: {
  amountCents: number;
  state: GlimState;
  lotNumbers: readonly number[];
  adjustments: readonly ValidationIssue[];
}): HoldCard {
  return {
    type: "hold",
    amountCents: input.amountCents,
    currentHoldCents: input.state.holdCents,
    lotNumbers: [...input.lotNumbers],
    notes: input.adjustments.map((adjustment) => adjustment.message),
  };
}

/** The amounts a card vouches for, which Glim's reply may repeat alongside the snapshot's. */
export function cardAmounts(card: GlimCard | null): Set<number> {
  const amounts = new Set<number>();
  if (card?.type === "plan") {
    for (const cents of [card.budgetCents, card.totalCents, card.holdCents, card.availableCents]) amounts.add(cents);
    for (const item of card.items) {
      amounts.add(item.maxCents);
      if (item.capCents !== null) amounts.add(item.capCents);
    }
  } else if (card?.type === "hold") {
    amounts.add(card.amountCents);
    if (card.currentHoldCents !== null) amounts.add(card.currentHoldCents);
  }
  return amounts;
}

function adjustmentLines(adjustments: readonly ValidationIssue[]): string[] {
  return adjustments.length === 0
    ? []
    : ["Fairhold adjusted your proposal first:", ...adjustments.map((adjustment) => `- ${adjustment.message}`)];
}

/** The tool result for a proposal that was shown, so later turns know exactly what the guest saw. */
export function describeCardForModel(card: GlimCard, state: GlimState, adjustments: readonly ValidationIssue[]): string {
  if (card.type === "hold") {
    return [
      ...adjustmentLines(adjustments),
      `Fairhold showed the guest a button to raise their bidding power to ${formatUsd(card.amountCents)} with PayPal. Nothing changes unless they approve a new hold.`,
    ].join("\n");
  }
  const lotsByNumber = new Map(state.lots.map((lot) => [lot.number, lot]));
  return [
    ...adjustmentLines(adjustments),
    `Fairhold showed the guest this ${card.kind === "change" ? "plan change" : "plan"}. Nothing is bid until they click Start bidding.`,
    `Budget ${formatUsd(card.budgetCents)} · maximums total ${formatUsd(card.totalCents)} · bidding power ${formatUsd(card.holdCents)}.`,
    ...card.items.map((item) => {
      const lot = lotsByNumber.get(item.lotNumber);
      const label = lot ? lotLabel(lot) : `Lot ${item.lotNumber}`;
      const cap = item.capCents === null ? "" : ", the guest's cap";
      return `- ${label}: maximum ${formatUsd(item.maxCents)} (priority ${item.priority}${cap})`;
    }),
  ].join("\n");
}

export function describeNoCardForModel(adjustments: readonly ValidationIssue[]): string {
  return [
    "Fairhold showed the guest nothing from this proposal:",
    ...adjustments.map((adjustment) => `- ${adjustment.message}`),
  ].join("\n");
}
