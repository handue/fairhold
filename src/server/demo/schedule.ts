/**
 * When each lot closes, on the story's evening and in a 25-minute demo gala. The same eight
 * lots close early in both, in the same order; the other sixteen close with the event.
 */
import { MINUTE, SECOND, STORY_CLOSES_AT, pm } from "./storyClock";

/** In closing order. */
export const STAGGERED_LOTS = [3, 5, 9, 21, 7, 18, 12, 14] as const;

// Read off the approved countdowns: 08 at 8:58:00 (Lot 07 18:42, Lot 03 07:55, ...) and 14 at
// 9:15:40 (Lot 18 04:35, Lot 12 08:30, Lot 14 14:00, the event 14:20).
const STORY_STAGGERED_CLOSES: Readonly<Record<(typeof STAGGERED_LOTS)[number], string>> = {
  3: "9:05:55",
  5: "9:07:30",
  9: "9:10:05",
  21: "9:13:20",
  7: "9:16:42",
  18: "9:20:15",
  12: "9:24:10",
  14: "9:29:40",
};

export function storyLotClosesAt(lotNumber: number): Date {
  const clock = STORY_STAGGERED_CLOSES[lotNumber as (typeof STAGGERED_LOTS)[number]];
  return clock ? pm(clock) : STORY_CLOSES_AT;
}

export const DEMO_LENGTH_MS = 25 * MINUTE;

// Between +10 and +20 minutes. Chef's Table and Spa Day stay open long enough for the golden
// path (hold, a manual bid, a Glim plan and the rival's $360) before they close.
const DEMO_STAGGERED_OFFSETS_MS: Readonly<Record<(typeof STAGGERED_LOTS)[number], number>> = {
  3: 10 * MINUTE,
  5: 11 * MINUTE,
  9: 12 * MINUTE,
  21: 13 * MINUTE,
  7: 15 * MINUTE,
  18: 16 * MINUTE + 30 * SECOND,
  12: 18 * MINUTE,
  14: 20 * MINUTE,
};

/** How long after a demo starts this lot closes. */
export function demoLotCloseOffsetMs(lotNumber: number): number {
  return DEMO_STAGGERED_OFFSETS_MS[lotNumber as (typeof STAGGERED_LOTS)[number]] ?? DEMO_LENGTH_MS;
}
