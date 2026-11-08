/**
 * The fixture moves to any evening as a whole, keeping its wall-clock times and every figure, and
 * by default picks an evening the engine still accepts bids on.
 */
import { describe, expect, it } from "vitest";

import { buildFixtureEventPlan } from "@/server/demo/fixturePlan";
import type { EventPlan } from "@/server/demo/plan";
import {
  defaultFixtureDate,
  FIXTURE_MOMENTS,
  fixtureMomentAt,
  HOUR,
  isCalendarDate,
  pm,
  storyShiftMs,
  STORY_TIME_ZONE,
  type FixtureMoment,
} from "@/server/demo/storyClock";

const DAY = 24 * HOUR;
const MOMENTS = Object.keys(FIXTURE_MOMENTS) as FixtureMoment[];

const pacific = (at: Date) =>
  at.toLocaleString("en-US", {
    timeZone: STORY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
const wallClock = (at: Date) => pacific(at).split(", ")[1];
const dateOf = (at: Date) => pacific(at).split(", ")[0];

/** Every Date in a value, in a stable order. */
function datesIn(value: unknown): Date[] {
  if (value instanceof Date) return [value];
  if (Array.isArray(value)) return value.flatMap(datesIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(datesIn);
  return [];
}

/** A plan with every Date replaced by a marker, to compare the rest. */
function withoutDates(plan: EventPlan): unknown {
  return JSON.parse(JSON.stringify(plan, (_key, value: unknown) => (typeof value === "string" && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value) ? "date" : value)));
}

describe("storyShiftMs", () => {
  it("is zero on the story's own evening and whole days after it", () => {
    expect(storyShiftMs("2026-11-07")).toBe(0);
    expect(storyShiftMs("2026-11-08")).toBe(DAY);
    expect(storyShiftMs("2026-11-12")).toBe(5 * DAY);
    expect(storyShiftMs("2026-11-01")).toBe(-6 * DAY);
  });

  it("keeps the wall clock across a daylight saving boundary", () => {
    // Daylight saving time starts on March 14, 2027, so a whole number of days would read 10:30 PM.
    const summer = new Date(pm("9:30").getTime() + storyShiftMs("2027-03-20"));
    expect(wallClock(summer)).toBe("9:30:00 PM");
    expect(dateOf(summer)).toBe("03/20/2027");
    expect(storyShiftMs("2027-03-20") % DAY).toBe(-HOUR + DAY);
  });

  it("refuses anything but a real date", () => {
    expect(() => storyShiftMs("tomorrow")).toThrow(RangeError);
    expect(() => storyShiftMs("2026-02-30")).toThrow(RangeError);
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates written YYYY-MM-DD and nothing else", () => {
    expect(isCalendarDate("2026-11-08")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2026-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-1")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("defaultFixtureDate", () => {
  const at = (iso: string) => new Date(iso);

  it("is tonight while the 9:30 PM close is more than an hour away", () => {
    expect(defaultFixtureDate(at("2026-11-08T20:01:00Z"))).toBe("2026-11-08"); // 12:01 PM PST
    expect(defaultFixtureDate(at("2026-11-09T04:29:59Z"))).toBe("2026-11-08"); // 8:29:59 PM PST
    expect(defaultFixtureDate(at("2026-11-08T08:05:00Z"))).toBe("2026-11-08"); // 12:05 AM PST
  });

  it("is tomorrow from an hour before the close", () => {
    expect(defaultFixtureDate(at("2026-11-09T04:30:00Z"))).toBe("2026-11-09"); // exactly an hour left
    expect(defaultFixtureDate(at("2026-11-09T07:59:00Z"))).toBe("2026-11-09"); // 11:59 PM PST
  });

  it("reads the date in the gala's zone, not UTC", () => {
    // Already November 9 in UTC, still 4:00 PM on November 8 in Los Angeles.
    expect(defaultFixtureDate(at("2026-11-09T00:00:00Z"))).toBe("2026-11-08");
  });

  it("crosses a month and a year", () => {
    expect(defaultFixtureDate(at("2026-12-01T07:00:00Z"))).toBe("2026-12-01"); // 11 PM on Nov 30 PST
    expect(defaultFixtureDate(at("2027-01-01T07:00:00Z"))).toBe("2027-01-01"); // 11 PM on Dec 31 PST
  });

  it("holds on the days the clocks change", () => {
    expect(defaultFixtureDate(at("2027-03-15T03:00:00Z"))).toBe("2027-03-14"); // 8:00 PM PDT, more than an hour left
    expect(defaultFixtureDate(at("2027-03-15T03:31:00Z"))).toBe("2027-03-15"); // 8:31 PM PDT
  });
});

describe("a fixture moved to another evening", () => {
  it.each(MOMENTS)("keeps every figure and row at the %s moment", (moment) => {
    const story = buildFixtureEventPlan({ moment });
    const moved = buildFixtureEventPlan({ moment, on: "2026-11-11" });
    expect(withoutDates(moved)).toEqual(withoutDates(story));
  });

  it.each(MOMENTS)("moves every date by the same whole days at the %s moment", (moment) => {
    const storyDates = datesIn(buildFixtureEventPlan({ moment }));
    const movedDates = datesIn(buildFixtureEventPlan({ moment, on: "2026-11-11" }));
    expect(storyDates.length).toBeGreaterThan(300);
    expect(movedDates).toHaveLength(storyDates.length);
    movedDates.forEach((date, index) => {
      expect(date.getTime() - (storyDates[index]?.getTime() ?? 0)).toBe(4 * DAY);
    });
  });

  it("still reads Closes 9:30 PM, on the new date", () => {
    const { event, lots } = buildFixtureEventPlan({ moment: "catalog", on: "2026-11-10" });
    expect(pacific(event.closesAt)).toBe("11/10/2026, 9:30:00 PM");
    expect(pacific(event.opensAt)).toBe("11/10/2026, 7:00:00 PM");
    const chefsTable = lots.find((lot) => lot.number === 7);
    expect(chefsTable && pacific(chefsTable.closesAt)).toBe("11/10/2026, 9:16:42 PM");
  });

  it("stays on the story's own evening when no date is given", () => {
    expect(buildFixtureEventPlan({ moment: "catalog" }).event.closesAt).toEqual(pm("9:30"));
  });

  it("says when each moment falls", () => {
    expect(fixtureMomentAt("catalog").toISOString()).toBe("2026-11-08T04:58:00.000Z");
    expect(fixtureMomentAt("catalog", "2026-11-08").toISOString()).toBe("2026-11-09T04:58:00.000Z");
    expect(fixtureMomentAt("paddle", "2026-11-08").toISOString()).toBe("2026-11-09T05:15:40.000Z");
    expect(fixtureMomentAt("closed", "2026-11-08").toISOString()).toBe("2026-11-09T05:30:00.000Z");
  });
});
