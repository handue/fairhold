import { describe, expect, it } from "vitest";

import { formatClockTime, formatClosedTime } from "@/ui/format";
import { lotClockTime } from "@/ui/paddle/time";
import { receiptDate } from "@/ui/receipt/copy";

const TZ = "America/Los_Angeles";
const at = (time: string) => Date.parse(`2026-11-09T${time}-08:00`);

describe("a close that has happened reads one way on every page", () => {
  it("rounds to the nearest minute, as the seed story reads Lot 07's 9:16:42", () => {
    expect(formatClosedTime(at("21:16:42"), TZ)).toBe("9:17 PM");
    expect(formatClosedTime(at("21:16:29"), TZ)).toBe("9:16 PM");
    expect(formatClosedTime(at("21:30:00"), TZ)).toBe("9:30 PM");
  });

  it("gives Close bidding now's second the same minute in the nav, the lots and the receipt", () => {
    // The golden path's run closed at 2:03:3x: the nav and the receipt's date said 2:03, its lots 2:04.
    const closed = at("14:03:35");
    expect(lotClockTime(closed, TZ)).toBe("2:04 PM");
    expect(formatClosedTime(closed, TZ)).toBe("2:04 PM");
    expect(receiptDate(closed, TZ, "short")).toMatch(/· 2:04 PM$/);
  });

  it("keeps a close still ahead on its own minute, never a later one", () => {
    expect(formatClockTime(at("14:21:40"), TZ)).toBe("2:21 PM");
  });
});
