import { describe, expect, it } from "vitest";

import {
  formatBidCount,
  formatClockTime,
  formatCountdown,
  formatLotNumber,
  formatPaddleNumber,
  formatTimeAgo,
  formatUsd,
  formatWeekdayTime,
  isClosingSoon,
  keepTogether,
  wrapAtSeparators,
} from "./format";

const MINUTE = 60_000;

describe("formatUsd", () => {
  it("shows whole dollars without cents", () => {
    expect(formatUsd(32_000)).toBe("$320");
    expect(formatUsd(684_000)).toBe("$6,840");
    expect(formatUsd(0)).toBe("$0");
  });

  it("shows cents only when there are some", () => {
    expect(formatUsd(1_250)).toBe("$12.50");
  });
});

describe("formatCountdown", () => {
  it("pads minutes and seconds like the approved tiles", () => {
    expect(formatCountdown(18 * MINUTE + 42_000)).toBe("18:42");
    expect(formatCountdown(7 * MINUTE + 55_000)).toBe("07:55");
  });

  it("rounds a partial second up and never goes below zero", () => {
    expect(formatCountdown(59_001)).toBe("01:00");
    expect(formatCountdown(-5_000)).toBe("00:00");
  });

  it("adds hours past sixty minutes", () => {
    expect(formatCountdown(65 * MINUTE + 9_000)).toBe("1:05:09");
  });
});

describe("isClosingSoon", () => {
  it("is true strictly under ten minutes", () => {
    expect(isClosingSoon(9 * MINUTE + 30_000)).toBe(true);
    expect(isClosingSoon(10 * MINUTE)).toBe(false);
  });
});

describe("event clock times", () => {
  // 9:30 PM on Saturday, November 7, 2026 in Los Angeles (PST, UTC-8).
  const close = Date.parse("2026-11-08T05:30:00Z");

  it("formats in the event's time zone with a plain space before PM", () => {
    expect(formatClockTime(close, "America/Los_Angeles")).toBe("9:30 PM");
    expect(formatClockTime(close, "America/New_York")).toBe("12:30 AM");
  });

  it("adds the weekday", () => {
    expect(formatWeekdayTime(Date.parse("2026-11-08T03:00:00Z"), "America/Los_Angeles")).toBe(
      "Sat 7:00 PM",
    );
  });
});

describe("small labels", () => {
  it("formats relative times", () => {
    expect(formatTimeAgo(20_000)).toBe("Just now");
    expect(formatTimeAgo(2 * MINUTE + 10_000)).toBe("2 min ago");
    expect(formatTimeAgo(125 * MINUTE)).toBe("2 hr ago");
  });

  it("pads lot and paddle numbers", () => {
    expect(formatLotNumber(7)).toBe("07");
    expect(formatLotNumber(21)).toBe("21");
    expect(formatPaddleNumber(88)).toBe("088");
    expect(formatPaddleNumber(142)).toBe("142");
  });

  it("counts bids", () => {
    expect(formatBidCount(0)).toBe("No bids yet");
    expect(formatBidCount(1)).toBe("1 bid");
    expect(formatBidCount(12)).toBe("12 bids");
  });
});

describe("line breaks", () => {
  it("keeps a time or a phrase whole with no-break spaces", () => {
    expect(keepTogether("9:30 PM")).toBe("9:30\u00a0PM");
    expect(keepTogether("Estimated value $600")).toBe("Estimated\u00a0value\u00a0$600");
    expect(keepTogether("Lot")).toBe("Lot");
  });

  it("wraps a dotted line only after its separators, each dot with the part before it", () => {
    const line = wrapAtSeparators("Private 25-minute gala · 24 lots · PayPal sandbox, no real money");
    expect(line).toBe("Private\u00a025-minute\u00a0gala\u00a0· 24\u00a0lots\u00a0· PayPal\u00a0sandbox,\u00a0no\u00a0real\u00a0money");
    // The same words: only the kind of space changes.
    expect(line.replaceAll("\u00a0", " ")).toBe("Private 25-minute gala · 24 lots · PayPal sandbox, no real money");
  });
});
