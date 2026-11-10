import { describe, expect, it } from "vitest";

import { parsePowerAmount, powerHref, powerHrefForLot } from "@/ui/power/power-href";

describe("powerHref", () => {
  const links = { slug: "gala-1", paddle: null };

  it("is the event's bidding power page", () => {
    expect(powerHref(links)).toBe("/e/gala-1/power");
  });

  it("carries the way back", () => {
    const href = new URL(powerHref(links, "/e/gala-1/lots/07"), "https://x.example");
    expect(href.pathname).toBe("/e/gala-1/power");
    expect(href.searchParams.get("next")).toBe("/e/gala-1/lots/07");
  });

  it("keeps a viewer chosen with ?paddle= outside production", () => {
    expect(powerHref({ slug: "gala-1", paddle: 142 })).toBe("/e/gala-1/power?paddle=142");
  });

  it("comes back to a lot for a bid that needs bidding power first", () => {
    const href = new URL(powerHrefForLot(links, 7), "https://x.example");
    expect(href.searchParams.get("next")).toBe("/e/gala-1/lots/07");
    expect(href.searchParams.has("raise")).toBe(false);
  });

  it("asks for the raise that covers a bid, in whole dollars, which 09 reads back", () => {
    const href = new URL(powerHrefForLot(links, 7, 840_00), "https://x.example");
    expect(href.searchParams.get("raise")).toBe("840");
    expect(parsePowerAmount({ raise: href.searchParams.get("raise") ?? undefined })).toBe(840_00);
  });

  it("leaves out a raise that isn't whole dollars", () => {
    expect(powerHref(links, null, 840_50)).toBe("/e/gala-1/power");
    expect(powerHref(links, null, 0)).toBe("/e/gala-1/power");
  });
});

describe("parsePowerAmount", () => {
  it("reads whole dollars from ?amount= or ?raise=", () => {
    expect(parsePowerAmount({ amount: "600" })).toBe(600_00);
    expect(parsePowerAmount({ raise: "750" })).toBe(750_00);
    expect(parsePowerAmount({ amount: ["600", "700"] })).toBe(600_00);
  });

  it("reads a bare ?raise as no amount", () => {
    expect(parsePowerAmount({})).toBeNull();
    expect(parsePowerAmount({ raise: "" })).toBeNull();
  });

  it("prefers ?amount= and falls through a bad one", () => {
    expect(parsePowerAmount({ amount: "600", raise: "750" })).toBe(600_00);
    expect(parsePowerAmount({ amount: "abc", raise: "750" })).toBe(750_00);
  });

  it.each(["abc", "12.50", "-5", "0", "$600", "99999999"])("reads %s as no amount", (amount) => {
    expect(parsePowerAmount({ amount })).toBeNull();
  });
});
