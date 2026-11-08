import { afterEach, describe, expect, it, vi } from "vitest";

import { exampleLotName, getPowerView } from "@/server/holds/view";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPowerView without a database", () => {
  it("renders the fixture with the template's hold rules, for design checks", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");

    expect(await getPowerView({ slug: "riverside-shelter-gala", paddleNumber: 142 })).toMatchObject({
      event: { name: "Riverside Shelter Gala" },
      viewer: { paddleNumber: 142, firstName: "Jamie", holdCents: 500_00 },
      limits: { presetsCents: [250_00, 500_00, 1_000_00], minCents: 25_00, maxCents: 1_000_00 },
      currentHoldCents: 500_00,
      committedCents: 0,
      biddingEnded: false,
      exampleLot: "Chef’s Table Dinner",
    });
  });

  it("has no view for an unknown event", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");
    expect(await getPowerView({ slug: "no-such-gala", paddleNumber: 142 })).toBeNull();
  });
});

describe("exampleLotName", () => {
  const lot = (title: string, category: "dining" | "art" | "pets" = "dining", status: "open" | "closed" = "open") => ({
    title,
    category,
    status,
  });

  it("names the approved example", () => {
    expect(exampleLotName([lot("Name the Next Shelter Puppy", "pets"), lot("Chef’s Table Dinner for Four")])).toBe(
      "Chef’s Table Dinner",
    );
  });

  it("drops only a party size", () => {
    expect(exampleLotName([lot("Private Wine Tasting for Six")])).toBe("Private Wine Tasting");
    expect(exampleLotName([lot("Bakery Box for a Year")])).toBe("Bakery Box for a Year");
  });

  it("moves on when the lot has closed, and falls back to any open lot", () => {
    expect(exampleLotName([lot("Chef’s Table Dinner for Four", "dining", "closed"), lot("Bakery Box for a Year")])).toBe(
      "Bakery Box for a Year",
    );
    expect(exampleLotName([lot("Chef’s Table", "dining", "closed"), lot("Photo Print", "art")])).toBe("Photo Print");
  });

  it("has nothing to name when every lot has closed", () => {
    expect(exampleLotName([lot("Chef’s Table", "dining", "closed")])).toBeNull();
    expect(exampleLotName([])).toBeNull();
  });
});
