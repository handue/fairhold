/**
 * The evening the approved screens were drawn in: Saturday, November 7, 2026, from 7:00 to
 * 9:30 PM in Riverside's time zone. Story times are written as evening clock times ("9:14:05").
 */
const STORY_DAY = "2026-11-07";
// Daylight saving time ends on November 1, 2026, so the gala runs on Pacific Standard Time.
const STORY_UTC_OFFSET = "-08:00";

const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** An evening clock time on the gala's day, e.g. pm("9:14:05") is 9:14:05 PM. */
export function pm(clock: string): Date {
  const match = CLOCK.exec(clock);
  if (!match) throw new RangeError(`Not a clock time: ${clock}`);
  const [, hours, minutes, seconds = "00"] = match;
  const hour = Number(hours);
  if (hour < 1 || hour > 11) throw new RangeError(`Not an evening time: ${clock}`);
  const iso = `${STORY_DAY}T${String(hour + 12)}:${minutes}:${seconds}${STORY_UTC_OFFSET}`;
  return new Date(iso);
}

export const STORY_OPENS_AT = pm("7:00");
export const STORY_CLOSES_AT = pm("9:30");

/**
 * The instants the approved screens show. Visual checks must freeze the app's clock at the
 * moment they render, since every countdown is computed from now.
 */
export const FIXTURE_MOMENTS = {
  /** 08 Lots and 05 Lot 07: Jamie leads Lot 07 at $320 by hand; 18:42 left on it. */
  catalog: pm("8:58:00"),
  /** 10 My paddle and 14 Projector, the same second: Glim at work, 14:20 left in the gala. */
  paddle: pm("9:15:40"),
  /** 12 Control room: bidding has closed and nothing has been charged yet. */
  closed: STORY_CLOSES_AT,
} as const;

export type FixtureMoment = keyof typeof FIXTURE_MOMENTS;

/** A demo gala starts at the catalog moment: its opening bids are the story's bids up to then. */
export const DEMO_ANCHOR = FIXTURE_MOMENTS.catalog;

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
