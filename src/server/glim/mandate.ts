/**
 * The guest's mandate: the rules they consented to by clicking Start bidding on a plan card. It
 * bounds everything Glim's autopilot may do on its own (docs/planning/glim-autopilot.md §2): the
 * budget they named, the lots it may use with their ranks and caps, and the lots they ruled out.
 * It is stored on the plan row (glim_plans.mandate) and read through mandateSchema every time.
 * Pure: nothing here reads the database or touches the engine.
 */
import { z } from "zod";

import { availableForPlan } from "./allocator";
import type { PlanCard } from "./cards";
import { isOpenForBids } from "./prompt";
import { sanitizeLabel } from "./sanitize";
import type { GlimCommitment, GlimLotState } from "./types";

/** The guest's words kept with a mandate: data for the decision step, never instructions. */
export const MANDATE_GUEST_WORDS = 3;
export const MANDATE_WORDS_LENGTH = 300;
/** A lot that closes sooner than this is never given a new or changed limit. */
export const CLOSE_MARGIN_MS = 5_000;

const cents = z.number().int().positive().max(2_147_483_647);

export const mandateLotSchema = z
  .object({
    lotId: z.string().min(1),
    lotNumber: z.number().int().positive(),
    role: z.enum(["plan", "backup"]),
    /** Plan lots are always "words". */
    source: z.enum(["words", "heart"]),
    /** 1..k for plan lots, k+1 for named backups, k+2 for hearted ones. */
    rank: z.number().int().positive(),
    /** The guest's own cap for this lot. */
    capCents: cents.nullable(),
  })
  .strict();

export const mandateSchema = z
  .object({
    v: z.literal(1),
    /** The budget the guest named; null when they named none (then the hold bounds Glim). */
    budgetCents: cents.nullable(),
    lots: z.array(mandateLotSchema),
    excludedLotIds: z.array(z.string().min(1)),
    guestWords: z.array(z.string().max(MANDATE_WORDS_LENGTH)).max(MANDATE_GUEST_WORDS),
    /** ISO instant; also the cut-off for guest-controlled lots. */
    confirmedAt: z.string().refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO instant"),
  })
  .strict();

export type GlimMandateV1 = z.infer<typeof mandateSchema>;
export type GlimMandate = GlimMandateV1;
export type MandateLot = z.infer<typeof mandateLotSchema>;

/** A stored mandate, or null when there is none or it does not parse (then autopilot stays off). */
export function parseMandate(value: unknown): GlimMandate | null {
  if (value === null || value === undefined) return null;
  const parsed = mandateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The guest's words as a mandate keeps them: one plain line each, at most 300 characters. */
export function mandateWords(words: readonly string[]): string[] {
  return words
    .map((text) => sanitizeLabel(text, MANDATE_WORDS_LENGTH))
    .filter((text) => text.length > 0)
    .slice(-MANDATE_GUEST_WORDS);
}

/**
 * The budget B a card grants once confirmed (§2.2): the budget the guest named in that turn, never
 * clamped (it may be above the hold; then it is the most Glim may ask them to approve). A change
 * card with no named budget keeps the running mandate's B, but never above the budget the card
 * shows, which is its maxima's total when no budget was named: confirming it can only lower B.
 * Null when no budget bounds Glim and the hold does. The card's rules line (V1) states this B.
 */
export function cardMandateBudgetCents(
  card: Pick<PlanCard, "tool" | "namedBudgetCents"> & Partial<Pick<PlanCard, "budgetCents">>,
  running: Pick<GlimMandate, "budgetCents"> | null,
): number | null {
  if (card.namedBudgetCents !== null) return card.namedBudgetCents;
  if (card.tool !== "propose_change" || running === null || running.budgetCents === null) return null;
  const shown = card.budgetCents;
  return shown !== undefined && shown > 0 ? Math.min(running.budgetCents, shown) : running.budgetCents;
}

export interface ConfirmedCardInput {
  card: Pick<PlanCard, "tool" | "items" | "backups" | "excluded" | "namedBudgetCents"> &
    Partial<Pick<PlanCard, "budgetCents" | "mandateBudgetCents">>;
  /** The guest's message behind the card, as stored; sanitized here. */
  guestWords: readonly string[];
  confirmedAt: Date;
  /** The running plan's mandate when the card changes it, else null. */
  previous: GlimMandate | null;
}

/**
 * The mandate a confirmed card grants. Plan lots keep the guest's priorities as ranks; named
 * backups rank right after them and hearted ones after those. Every cap on the card is a guest
 * cap: on a change card a "keep this maximum" cap equals the current maximum, which can only make
 * Glim do less. A change card is merged into the running mandate (mergeMandateOnChange). B follows
 * cardMandateBudgetCents, and is never above the B the card's rules line stated.
 */
export function mandateFromConfirmedCard(input: ConfirmedCardInput): GlimMandate {
  const merged = input.previous !== null && input.card.tool === "propose_change";
  const mandate = mandateFromCard(input, merged ? input.previous : null);
  let budgetCents = cardMandateBudgetCents(input.card, merged ? input.previous : null);
  const stated = input.card.mandateBudgetCents;
  if (stated !== undefined && stated !== null) budgetCents = budgetCents === null ? stated : Math.min(budgetCents, stated);
  return { ...mandate, budgetCents };
}

function mandateFromCard(input: ConfirmedCardInput, previous: GlimMandate | null): GlimMandate {
  const { card } = input;
  const planRank = Math.max(1, ...card.items.map((item) => item.priority));
  const lots: MandateLot[] = card.items.map((item) => ({
    lotId: item.lotId,
    lotNumber: item.lotNumber,
    role: "plan",
    source: "words",
    rank: item.priority,
    capCents: item.capCents,
  }));
  for (const backup of card.backups) {
    if (lots.some((lot) => lot.lotId === backup.lotId)) continue;
    lots.push({
      lotId: backup.lotId,
      lotNumber: backup.lotNumber,
      role: "backup",
      source: backup.source,
      rank: planRank + (backup.source === "words" ? 1 : 2),
      capCents: null,
    });
  }
  const excludedLotIds = [...new Set(card.excluded.map((lot) => lot.lotId))];
  const fresh: GlimMandate = {
    v: 1,
    budgetCents: card.namedBudgetCents,
    lots: lots.filter((lot) => !excludedLotIds.includes(lot.lotId)),
    excludedLotIds,
    guestWords: mandateWords(input.guestWords),
    confirmedAt: input.confirmedAt.toISOString(),
  };
  return previous === null ? fresh : mergeMandateOnChange(previous, fresh);
}

/**
 * A confirmed change card on top of the running mandate. A null budget keeps the guest's earlier
 * one; a lot without a cap keeps an earlier cap; exclusions carry over unless the guest planned
 * the lot again or named it as a backup on this card; the guest's words accumulate (last 3).
 */
export function mergeMandateOnChange(previous: GlimMandate, next: GlimMandate): GlimMandate {
  const previousCaps = new Map(previous.lots.map((lot) => [lot.lotId, lot.capCents]));
  const chosen = new Set(next.lots.filter((lot) => lot.source === "words").map((lot) => lot.lotId));
  const excluded = new Set(
    [...previous.excludedLotIds.filter((lotId) => !chosen.has(lotId)), ...next.excludedLotIds],
  );
  return {
    v: 1,
    budgetCents: next.budgetCents ?? previous.budgetCents,
    lots: next.lots
      .filter((lot) => !excluded.has(lot.lotId))
      .map((lot) => ({ ...lot, capCents: lot.capCents ?? previousCaps.get(lot.lotId) ?? null })),
    excludedLotIds: [...excluded],
    guestWords: [...previous.guestWords, ...next.guestWords].slice(-MANDATE_GUEST_WORDS),
    confirmedAt: next.confirmedAt,
  };
}

export function mandateLot(mandate: GlimMandate, lotId: string): MandateLot | null {
  return mandate.lots.find((lot) => lot.lotId === lotId) ?? null;
}

/** The lot's rank in the guest's order, or null when the mandate does not include it. */
export function mandateRank(mandate: GlimMandate, lotId: string): number | null {
  return mandateLot(mandate, lotId)?.rank ?? null;
}

export function guestCapCents(mandate: GlimMandate, lotId: string): number | null {
  return mandateLot(mandate, lotId)?.capCents ?? null;
}

/** The mandate's lots in the guest's order: rank, then lot number. */
export function rankedMandateLots(mandate: GlimMandate): MandateLot[] {
  return [...mandate.lots]
    .filter((lot) => !mandate.excludedLotIds.includes(lot.lotId))
    .sort((a, b) => a.rank - b.rank || a.lotNumber - b.lotNumber);
}

/** Facts about a lot that only the live auction knows, read fresh for each decision. */
export interface LotAvailability {
  now: Date;
  /** An active guest max, or one set since the mandate was confirmed. */
  guestControlledLotIds: ReadonlySet<string>;
  /** A Glim limit of this paddle there was outbid in the very action that created it, recently. */
  contestedLotIds: ReadonlySet<string>;
  /** Autopilot dropped it within the last two minutes. */
  recentlyDroppedLotIds: ReadonlySet<string>;
}

export type LotBlocker =
  | "outside_mandate"
  | "excluded_lot"
  | "closes_too_soon"
  | "guest_controlled_lot"
  | "contested_lot"
  | "recently_dropped";

/**
 * Why autopilot may not put money on this lot, or null when it may: the lot must be in the
 * mandate and not ruled out, open for bids for more than 5 s, not under the guest's own max, not
 * contested and not dropped by autopilot in the last two minutes.
 */
export function lotBlocker(lot: GlimLotState, mandate: GlimMandate, facts: LotAvailability): LotBlocker | null {
  if (mandate.excludedLotIds.includes(lot.id)) return "excluded_lot";
  if (!mandateLot(mandate, lot.id)) return "outside_mandate";
  if (!isOpenForBids(lot, facts.now) || lot.closesAt.getTime() - facts.now.getTime() <= CLOSE_MARGIN_MS) {
    return "closes_too_soon";
  }
  if (facts.guestControlledLotIds.has(lot.id)) return "guest_controlled_lot";
  if (facts.contestedLotIds.has(lot.id)) return "contested_lot";
  if (facts.recentlyDroppedLotIds.has(lot.id)) return "recently_dropped";
  return null;
}

export function isAllowedLot(lot: GlimLotState, mandate: GlimMandate, facts: LotAvailability): boolean {
  return lotBlocker(lot, mandate, facts) === null;
}

export interface PlanBudgetInput {
  holdCents: number;
  /** The guest's named budget B, or null. */
  budgetCents: number | null;
  commitments: readonly GlimCommitment[];
  mandateLotNumbers: ReadonlySet<number>;
  /** P: the lots that will hold Glim limits after the change. */
  planLotNumbers: ReadonlySet<number>;
}

/**
 * What the maxima of P may add up to (§2.4): the hold minus every commitment outside P
 * (availableForPlan), and, when the guest named a budget, never more than that budget minus what
 * stays committed on the mandate's other lots (won lots, standing bids, the guest's own maxes).
 * Can be negative, when nothing fits.
 */
export function budgetForPlan(input: PlanBudgetInput): number {
  const available = availableForPlan(input.holdCents, input.commitments, input.planLotNumbers);
  if (input.budgetCents === null) return available;
  const stays = input.commitments
    .filter((commitment) => input.mandateLotNumbers.has(commitment.lotNumber) && !input.planLotNumbers.has(commitment.lotNumber))
    .reduce((sum, commitment) => sum + commitment.withoutGlimCents, 0);
  return Math.min(input.budgetCents - stays, available);
}

/** What the guest has committed on the mandate's lots: the figure the named budget bounds. */
export function spendInMandate(commitments: readonly GlimCommitment[], mandateLotNumbers: ReadonlySet<number>): number {
  return commitments
    .filter((commitment) => mandateLotNumbers.has(commitment.lotNumber))
    .reduce((sum, commitment) => sum + commitment.cents, 0);
}

export function mandateLotNumbers(mandate: GlimMandate): Set<number> {
  return new Set(mandate.lots.map((lot) => lot.lotNumber));
}
