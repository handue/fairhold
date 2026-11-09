import { formatClosedTime } from "../format";

/**
 * A lot's close in words, to the nearest minute: lots close on the second (Lot 07 at 9:16:42), and
 * 11, 14 and 26 read those as "Won at 9:17 PM" and "9:06" (src/server/demo/README.md).
 */
export function lotClockTime(at: number, timeZone: string): string {
  return formatClosedTime(at, timeZone);
}
