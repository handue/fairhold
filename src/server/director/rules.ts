/**
 * The director's rules, with no database and no clock of their own, so tests can walk through them
 * at any instant. Spec: docs/planning/glim-autopilot.md §12 for the golden
 * take, whose figures these rules exist to protect.
 */
import type { BotTarget } from "@/server/demo/botProfiles";

import { DIRECTOR_SEED, unitFromKey } from "./seed";

export const LOT_CHEFS_TABLE = 7;
export const LOT_WINE_TASTING = 9;
export const LOT_SPA_DAY = 12;

/**
 * Lots no background bot touches. The golden path reads a $320 hand bid on Chef's Table and Glim's
 * opening $90 on Spa Day, so these two move only when a guest or a rival job moves them.
 */
export const REACTIVE_ONLY_LOTS: ReadonlySet<number> = new Set([LOT_CHEFS_TABLE, LOT_SPA_DAY]);

const CEILING_CENTS: Readonly<Record<number, number>> = { [LOT_WINE_TASTING]: 37_000 };

/**
 * The highest bid the director may place on a lot. On Wine Tasting it is $370: Glim's move there can
 * go up to $380, and a director bid above that would take the lot from the guest in the golden take.
 */
export function directorCeilingCents(lotNumber: number): number {
  return CEILING_CENTS[lotNumber] ?? Number.MAX_SAFE_INTEGER;
}

/** The director leaves a lot alone this close to its end. */
export const LOT_END_MARGIN_MS = 5_000;
/** A background bid this late (the process was down) is dropped, so a restart brings no burst of bids. */
export const STALE_BOT_BID_MS = 120_000;

export interface DelayRange {
  minMs: number;
  maxMs: number;
}

export const RIVAL_UNDER_LIMIT_DELAY: DelayRange = { minMs: 20_000, maxMs: 40_000 };
export const RIVAL_OUTBID_DELAY: DelayRange = { minMs: 15_000, maxMs: 30_000 };
/** Long enough to read Glim's answer to the first rival and go back to browsing. */
export const RIVAL_OVER_LIMIT_GAP: DelayRange = { minMs: 40_000, maxMs: 55_000 };
const RIVAL_OVER_LIMIT_MIN_GAP_MS = 3_000;

/**
 * Glim can only move the money somewhere with time left, so the rival who passes its limit waits for
 * nothing and fires only while the lot it would move to has this long left. On Wine Tasting, which
 * closes at +12:00, that is the plan's "before +10:30".
 */
export const DESTINATION_MIN_LEFT_MS = 90_000;

/**
 * The tick starts a due job within about a second of its run_at, and the scan that queues a reaction
 * runs once a second, so delays aim this far inside their range.
 */
const TICK_MARGIN_MS = 2_000;

/** A delay inside `range` that depends only on `key`. */
export function delayWithin(range: DelayRange, key: string, seed: string = DIRECTOR_SEED): number {
  const span = Math.max(0, range.maxMs - TICK_MARGIN_MS - range.minMs);
  return range.minMs + Math.floor(unitFromKey(`${seed}:${key}`) * span);
}

/** When a rival bids Glim's priority-1 lot to one raise under its limit. */
export function rivalUnderLimitAt(confirmedAt: Date, paddleNumber: number, seed?: string): Date {
  return new Date(confirmedAt.getTime() + delayWithin(RIVAL_UNDER_LIMIT_DELAY, `under:${paddleNumber}`, seed));
}

/** When a rival outbids the guest on their second manual lot. */
export function rivalOutbidAt(secondLotBidAt: Date, paddleNumber: number, seed?: string): Date {
  return new Date(secondLotBidAt.getTime() + delayWithin(RIVAL_OUTBID_DELAY, `outbid:${paddleNumber}`, seed));
}

export interface OverLimitTiming {
  underLimitAt: Date;
  /** Close times of the lots Glim could move to; see destinationLotNumbers. */
  destinationClosesAt: readonly Date[];
  paddleNumber: number;
  seed?: string;
}

/**
 * When a rival passes Glim's limit: a beat after the first rival, moved up when that would leave the
 * destination under its 90 seconds. overLimitAllowed still decides when the job runs.
 */
export function rivalOverLimitAt({ underLimitAt, destinationClosesAt, paddleNumber, seed }: OverLimitTiming): Date {
  const after = underLimitAt.getTime() + delayWithin(RIVAL_OVER_LIMIT_GAP, `over:${paddleNumber}`, seed);
  const latest = Math.max(0, ...destinationClosesAt.map((at) => at.getTime())) - DESTINATION_MIN_LEFT_MS - TICK_MARGIN_MS;
  return new Date(Math.max(underLimitAt.getTime() + RIVAL_OVER_LIMIT_MIN_GAP_MS, Math.min(after, latest)));
}

export interface MandateBackup {
  lotNumber: number;
  role: "plan" | "backup";
  rank: number;
}

/**
 * Where Glim's money could go when its top lot gets away: the backups the guest confirmed, best
 * first. A plan with none falls back to Wine Tasting, the golden take's lot. A guest who named Wine
 * Club instead keeps the beat after Wine Tasting has closed, which is the take's fallback.
 */
export function destinationLotNumbers(lots: readonly MandateBackup[] | null | undefined): number[] {
  const backups = (lots ?? []).filter((lot) => lot.role === "backup").sort((a, b) => a.rank - b.rank);
  return backups.length > 0 ? backups.map((lot) => lot.lotNumber) : [LOT_WINE_TASTING];
}

export interface DestinationLot {
  status: string;
  closesAt: Date;
}

/** Whether a rival may pass Glim's limit now: some destination still has 90 seconds left. */
export function overLimitAllowed(destinations: readonly DestinationLot[], now: Date): boolean {
  return destinations.some(
    (lot) => lot.status === "open" && lot.closesAt.getTime() - now.getTime() >= DESTINATION_MIN_LEFT_MS,
  );
}

export interface RivalCandidate {
  id: string;
  number: number;
  /** What the engine says this paddle can still commit. */
  availableCents: number;
  targets: readonly BotTarget[];
}

export interface RivalNeed {
  lotNumber: number;
  amountCents: number;
  /** Never the lot's leader: nobody outbids themselves. */
  leadingPaddleId: string | null;
}

/**
 * The simulated guest who plays the rival: one with room on their hold, and preferably one the story
 * has wanting this lot at this price (Harold, paddle 88, on Chef's Table), then one wanting the lot.
 */
export function chooseRival(candidates: readonly RivalCandidate[], need: RivalNeed): RivalCandidate | null {
  const rank = (candidate: RivalCandidate): number => {
    const target = candidate.targets.find((entry) => entry.lotNumber === need.lotNumber);
    if (!target) return 2;
    return target.maxCents >= need.amountCents ? 0 : 1;
  };
  const able = candidates.filter(
    (candidate) => candidate.availableCents >= need.amountCents && candidate.id !== need.leadingPaddleId,
  );
  able.sort((a, b) => rank(a) - rank(b) || a.number - b.number);
  return able[0] ?? null;
}
