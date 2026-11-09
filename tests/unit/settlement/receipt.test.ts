import { describe, expect, it } from "vitest";

import { bidderName, lotsWonLabel } from "@/server/settlement/names";
import { deductibleCents, receiptNumber } from "@/server/settlement/receipt";
import { reauthorizationRound } from "@/server/settlement/reauthorize";

describe("deductibleCents", () => {
  it("is what was paid above the estimated value, and never below zero", () => {
    expect(deductibleCents(9_000, 7_000)).toBe(2_000);
    expect(deductibleCents(38_000, 48_000)).toBe(0);
    expect(deductibleCents(48_000, 48_000)).toBe(0);
    expect(deductibleCents(145_000, 0)).toBe(145_000);
  });

  it("is zero for a lot the organizer never valued", () => {
    expect(deductibleCents(9_000, null)).toBe(0);
  });
});

describe("receiptNumber", () => {
  it("is the gala's date in its own time zone, and the paddle", () => {
    // 9:30 PM on Nov 7 in Los Angeles is already Nov 8 in UTC.
    expect(receiptNumber(new Date("2026-11-08T05:30:00Z"), "America/Los_Angeles", 142)).toBe("1107-142");
    expect(receiptNumber(new Date("2026-11-08T05:30:00Z"), "Asia/Seoul", 142)).toBe("1108-142");
    expect(receiptNumber(new Date("2026-01-02T20:00:00Z"), "America/Los_Angeles", 7)).toBe("0102-007");
  });
});

describe("bidderName", () => {
  it("adds the initial a seeded guest has, and none for a real guest", () => {
    expect(bidderName("Jamie", "K")).toBe("Jamie K.");
    expect(bidderName("Sam", null)).toBe("Sam");
  });
});

describe("lotsWonLabel", () => {
  const lot = (title: string, shortTitle: string) => ({ title, shortTitle });

  it("names one lot by its title, several by their short titles", () => {
    expect(lotsWonLabel([])).toBe("");
    expect(lotsWonLabel([lot("Name the Next Shelter Puppy", "Name the Puppy")])).toBe("Name the Next Shelter Puppy");
    expect(lotsWonLabel([lot("Chef’s Table Dinner for Four", "Chef’s Table"), lot("Spa Day for Two", "Spa Day")])).toBe("Chef’s Table, Spa Day");
  });

  it("keeps the two full names the approved ledger uses beside another lot", () => {
    expect(lotsWonLabel([lot("Private Wine Tasting for Six", "Wine Tasting"), lot("Wine Club, Six Months", "Wine Club")])).toBe(
      "Private Wine Tasting for Six, Wine Club",
    );
    expect(lotsWonLabel([lot("Dog Walking, One Month", "Dog Walking"), lot("Custom Pet Portrait", "Pet Portrait")])).toBe(
      "Dog Walking, Custom Pet Portrait",
    );
  });
});

describe("reauthorizationRound", () => {
  const DAY = 24 * 60 * 60 * 1_000;
  const start = new Date("2026-11-01T00:00:00Z");
  const after = (days: number) => new Date(start.getTime() + days * DAY);

  it("gives each honor period its own round, so a later reauthorization is a new request", () => {
    expect(reauthorizationRound(start, after(3))).toBe(1);
    expect(reauthorizationRound(start, after(5.9))).toBe(1);
    expect(reauthorizationRound(start, after(6))).toBe(2);
    expect(reauthorizationRound(start, after(9))).toBe(3);
  });

  it("starts at 1 for a hold with no authorization time, or one still inside its period", () => {
    expect(reauthorizationRound(null, after(9))).toBe(1);
    expect(reauthorizationRound(start, after(1))).toBe(1);
  });
});
