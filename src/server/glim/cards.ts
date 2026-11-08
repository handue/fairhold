/**
 * What a validated proposal becomes: the card the guest reviews (07's plan card, or a raise
 * bidding power button) and the tool result the model reads back. Both are written by code from
 * validated numbers, so every amount on them is exact.
 */
import type { Allocation } from "./allocator";
import { cardMandateBudgetCents } from "./mandate";
import { formatUsd } from "./money";
import { isOpenForBids, lotLabel } from "./prompt";
import type { GlimLotState, GlimState, PlanIntent, PlanToolName, ValidationIssue } from "./types";

/** At most this many backups on a card, and so in a mandate (docs/planning/glim-autopilot.md §2.2). */
export const MAX_CARD_BACKUPS = 4;

export interface PlanCardLotRef {
  lotId: string;
  lotNumber: number;
  shortTitle: string;
}

/** A lot Glim may switch to on its own, as the card's "ON MY OWN" block lists it. */
export interface PlanCardBackup extends PlanCardLotRef {
  /** words: the guest named it as a backup; heart: the guest hearted it. */
  source: "words" | "heart";
  /** The same status line as a plan item, such as "Current bid $210". */
  statusText: string;
}

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
  /** Named backups first, then the guest's open hearted lots, soonest closing first; at most 4. */
  backups: PlanCardBackup[];
  /** Lots the guest ruled out, which Glim never bids on. */
  excluded: PlanCardLotRef[];
  excludedLotNumbers: number[];
  /**
   * The budget as the guest named it this turn, before any clamp to the bidding power; null
   * when they named none. Confirming the card makes it the mandate's budget.
   */
  namedBudgetCents: number | null;
  /**
   * The budget B confirming this card gives Glim's autopilot (cardMandateBudgetCents): the named
   * budget, else on a change card the running mandate's B, never above this card's budget. Null
   * when the bidding power alone bounds Glim. The "ON MY OWN" rules line states it.
   */
  mandateBudgetCents: number | null;
  /** False when GLIM_AUTOPILOT=off: no "ON MY OWN" block, and confirming arms nothing. */
  autopilot: boolean;
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

/**
 * The backups a card lists: the lots the guest named as backups, then their open hearted lots
 * that are neither planned nor ruled out, soonest closing first; at most four, each open for bids.
 * Hearts added after the card is confirmed never widen what Glim may do.
 */
export function planCardBackups(intent: Pick<PlanIntent, "items" | "backupLotNumbers" | "excludedLotNumbers">, state: GlimState): PlanCardBackup[] {
  const planned = new Set(intent.items.map((item) => item.lotNumber));
  const excluded = new Set(intent.excludedLotNumbers ?? []);
  const lotsByNumber = new Map(state.lots.map((lot) => [lot.number, lot]));
  const eligible = (lotNumber: number): GlimLotState | null => {
    const lot = lotsByNumber.get(lotNumber);
    if (!lot || planned.has(lotNumber) || excluded.has(lotNumber) || !isOpenForBids(lot, state.now)) return null;
    return lot;
  };

  const backups: PlanCardBackup[] = [];
  const add = (lot: GlimLotState, source: PlanCardBackup["source"]) => {
    if (backups.length >= MAX_CARD_BACKUPS || backups.some((backup) => backup.lotNumber === lot.number)) return;
    backups.push({
      lotId: lot.id,
      lotNumber: lot.number,
      shortTitle: lot.shortTitle,
      source,
      statusText: planItemStatusText(lot),
    });
  };
  for (const lotNumber of intent.backupLotNumbers ?? []) {
    const lot = eligible(lotNumber);
    if (lot) add(lot, "words");
  }
  const hearted = state.favoriteLotNumbers
    .map(eligible)
    .filter((lot): lot is GlimLotState => lot !== null)
    .sort((a, b) => a.closesAt.getTime() - b.closesAt.getTime() || a.number - b.number);
  for (const lot of hearted) add(lot, "heart");
  return backups;
}

function excludedLots(intent: Pick<PlanIntent, "excludedLotNumbers">, state: GlimState): PlanCardLotRef[] {
  const lotsByNumber = new Map(state.lots.map((lot) => [lot.number, lot]));
  return [...new Set(intent.excludedLotNumbers ?? [])].flatMap((lotNumber) => {
    const lot = lotsByNumber.get(lotNumber);
    return lot ? [{ lotId: lot.id, lotNumber: lot.number, shortTitle: lot.shortTitle }] : [];
  });
}

export function buildPlanCard(input: {
  tool: PlanToolName;
  allocation: Allocation;
  state: GlimState;
  adjustments: readonly ValidationIssue[];
  /** The intent the allocation came from; its backups and exclusions go on the card. */
  intent?: Pick<PlanIntent, "items" | "backupLotNumbers" | "excludedLotNumbers">;
  /** The budget the guest named this turn (GlimProposalRecord.namedBudgetCents). */
  namedBudgetCents?: number | null;
  /** Whether Glim's autopilot is on (GLIM_AUTOPILOT); defaults to on. */
  autopilot?: boolean;
}): PlanCard {
  const { allocation, state } = input;
  const replacesActive = state.plan !== null && state.plan.status !== "proposed";
  const intent = input.intent ?? { items: allocation.items.map((item) => ({ lotNumber: item.lot.number, priority: item.priority, capCents: item.capCents })) };
  const excluded = excludedLots(intent, state);
  const budgetCents = allocation.budgetCents ?? allocation.totalCents;
  const namedBudgetCents = input.namedBudgetCents === undefined ? allocation.budgetCents : input.namedBudgetCents;
  // The running plan's mandate, which confirming a change card merges into (confirmPlan).
  const running = replacesActive ? (state.plan?.mandate ?? null) : null;
  return {
    type: "plan",
    kind: replacesActive ? "change" : "new",
    replacesPlanId: state.plan?.id ?? null,
    tool: input.tool,
    budgetCents,
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
    backups: planCardBackups(intent, state),
    excluded,
    excludedLotNumbers: excluded.map((lot) => lot.lotNumber),
    namedBudgetCents,
    mandateBudgetCents: cardMandateBudgetCents({ tool: input.tool, namedBudgetCents, budgetCents }, running),
    autopilot: input.autopilot ?? true,
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
    if (card.namedBudgetCents !== null) amounts.add(card.namedBudgetCents);
    if (card.mandateBudgetCents !== null) amounts.add(card.mandateBudgetCents);
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
  const labelOf = (lotNumber: number) => {
    const lot = lotsByNumber.get(lotNumber);
    return lot ? lotLabel(lot) : `Lot ${lotNumber}`;
  };
  const autopilotLines: string[] = [];
  if (card.autopilot && card.backups.length > 0) {
    const backups = card.backups.map(
      (backup) => `${labelOf(backup.lotNumber)} (${backup.source === "heart" ? "the guest hearted it" : "a backup the guest named"})`,
    );
    autopilotLines.push(`Backups Glim may switch to on its own: ${backups.join(", ")}.`);
  }
  if (card.excludedLotNumbers.length > 0) {
    autopilotLines.push(`Ruled out by the guest: ${card.excludedLotNumbers.map(labelOf).join(", ")}.`);
  }
  if (card.namedBudgetCents !== null && card.namedBudgetCents > card.holdCents) {
    autopilotLines.push(
      `The guest named ${formatUsd(card.namedBudgetCents)}, above their ${formatUsd(card.holdCents)} bidding power; the plan stays within the bidding power.`,
    );
  }
  return [
    ...adjustmentLines(adjustments),
    `Fairhold showed the guest this ${card.kind === "change" ? "plan change" : "plan"}. Nothing is bid until they click Start bidding.`,
    `Budget ${formatUsd(card.budgetCents)} · maximums total ${formatUsd(card.totalCents)} · bidding power ${formatUsd(card.holdCents)}.`,
    ...card.items.map((item) => {
      const cap = item.capCents === null ? "" : ", the guest's cap";
      return `- ${labelOf(item.lotNumber)}: maximum ${formatUsd(item.maxCents)} (priority ${item.priority}${cap})`;
    }),
    ...autopilotLines,
  ].join("\n");
}

export function describeNoCardForModel(adjustments: readonly ValidationIssue[]): string {
  return [
    "Fairhold showed the guest nothing from this proposal:",
    ...adjustments.map((adjustment) => `- ${adjustment.message}`),
  ].join("\n");
}
