/**
 * The evening the approved screens were drawn in: Saturday, November 7, 2026, from 7:00 to
 * 9:30 PM in Riverside's time zone. Story times are written as evening clock times ("9:14:05").
 * The story itself always stays on this date; the fixture moves it to another evening afterwards
 * (storyShiftMs), so no story time depends on the day it runs.
 */
const STORY_DAY = "2026-11-07";
export const STORY_TIME_ZONE = "America/Los_Angeles";
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

// ---------------------------------------------------------------------------------------------
// Moving the story to another evening, for an event the engine still accepts bids on.

/** The default evening keeps its 9:30 PM close more than this far away. */
const FIXTURE_MARGIN_MS = HOUR;

const ZONE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: STORY_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zoneFields(instant: number): Record<"year" | "month" | "day" | "hour" | "minute" | "second", number> {
  const parts = new Map(ZONE_PARTS.formatToParts(instant).map((part) => [part.type, Number(part.value)]));
  const field = (name: Intl.DateTimeFormatPartTypes) => parts.get(name) ?? 0;
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/** The zone's offset from UTC at an instant: negative west of Greenwich. */
function zoneOffsetMs(instant: number): number {
  const { year, month, day, hour, minute, second } = zoneFields(instant);
  return Date.UTC(year, month - 1, day, hour, minute, second) - Math.floor(instant / SECOND) * SECOND;
}

/** Whether a string is a real calendar date written "YYYY-MM-DD". */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function closesOn(date: string): number {
  if (!isCalendarDate(date)) throw new RangeError(`Not a calendar date: ${date}`);
  const asIfUtc = Date.parse(`${date}T21:30:00Z`);
  // The second pass settles the offset when the first guess fell across a change of offset.
  return asIfUtc - zoneOffsetMs(asIfUtc - zoneOffsetMs(asIfUtc));
}

/**
 * How far to move the story so it runs on `date` ("YYYY-MM-DD"): a whole number of days, plus the
 * change of UTC offset across a daylight saving boundary, so its wall-clock times stay as drawn.
 * The whole story sits on one evening, so one shift fits all of it.
 */
export function storyShiftMs(date: string): number {
  return closesOn(date) - STORY_CLOSES_AT.getTime();
}

/** The first evening whose 9:30 PM close is more than an hour after `now`. */
export function defaultFixtureDate(now: Date): string {
  const { year, month, day } = zoneFields(now.getTime());
  const today = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (closesOn(today) - now.getTime() > FIXTURE_MARGIN_MS) return today;
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** The instant a moment falls on when the story runs on `date`; the story's own date by default. */
export function fixtureMomentAt(moment: FixtureMoment, date?: string): Date {
  const at = FIXTURE_MOMENTS[moment].getTime();
  return new Date(date === undefined ? at : at + storyShiftMs(date));
}
