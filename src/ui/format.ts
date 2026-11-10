/** Display formatting for the guest screens. Money is integer cents; instants are epoch milliseconds. */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** Timers switch to the ink "soon" pill under this. */
export const CLOSING_SOON_MS = 10 * MINUTE;

const wholeDollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const dollarsAndCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "$320", "$6,840"; cents only when there are any: "$12.50". */
export function formatUsd(cents: number): string {
  const formatter = cents % 100 === 0 ? wholeDollars : dollarsAndCents;
  return formatter.format(cents / 100);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "18:42", "07:55", "1:05:09". Rounds up, so a lot never reads 00:00 while it is still open. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / SECOND));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const minutesAndSeconds = `${pad2(minutes)}:${pad2(seconds)}`;
  return hours > 0 ? `${hours}:${minutesAndSeconds}` : minutesAndSeconds;
}

export function isClosingSoon(remainingMs: number): boolean {
  return remainingMs < CLOSING_SOON_MS;
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function timeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = timeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    timeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function timeParts(at: number, timeZone: string) {
  const parts = timeFormatter(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return { weekday: part("weekday"), hour: part("hour"), minute: part("minute"), period: part("dayPeriod") };
}

/**
 * "9:30 PM" in the event's time zone. Assembled from parts because ICU puts a narrow no-break
 * space before AM/PM, which Geist Mono lacks and which differs between server and browser builds.
 */
export function formatClockTime(at: number, timeZone: string): string {
  const { hour, minute, period } = timeParts(at, timeZone);
  return `${hour}:${minute} ${period.toUpperCase()}`;
}

/**
 * A close that has happened, to the nearest minute. Lots close on the second (Lot 07 at 9:16:42 reads
 * "9:17 PM", src/server/demo/README.md), and "Close bidding now" ends the gala and its open lots on
 * the same second, so every page that names a past close rounds it this one way. A close still ahead
 * keeps formatClockTime, which never names a minute later than the real one.
 */
export function formatClosedTime(at: number, timeZone: string): string {
  return formatClockTime(Math.round(at / MINUTE) * MINUTE, timeZone);
}

/** "Sat 7:00 PM" in the event's time zone. */
export function formatWeekdayTime(at: number, timeZone: string): string {
  return `${timeParts(at, timeZone).weekday} ${formatClockTime(at, timeZone)}`;
}

/** "Just now", "2 min ago", "3 hr ago". */
export function formatTimeAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / MINUTE);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} hr ago`;
}

/** Lot numbers always show two digits: "Lot 07". */
export function formatLotNumber(lotNumber: number): string {
  return pad2(lotNumber);
}

/** Paddle numbers always show three digits: "Paddle 088". */
export function formatPaddleNumber(paddleNumber: number): string {
  return String(paddleNumber).padStart(3, "0");
}

export function formatBidCount(count: number): string {
  if (count === 0) return "No bids yet";
  return count === 1 ? "1 bid" : `${count} bids`;
}
