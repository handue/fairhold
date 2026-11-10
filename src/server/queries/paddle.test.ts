import { describe, expect, it } from "vitest";

import { feedLabel } from "./paddle";

describe("10's feed labels", () => {
  it("names a plan's first start, its later starts and its edits", () => {
    expect(feedLabel({ kind: "plan_started", short_title: null, first_plan: true })).toBe("PLAN STARTED");
    expect(feedLabel({ kind: "plan_started", short_title: null, first_plan: false })).toBe("PLAN UPDATED");
    expect(feedLabel({ kind: "plan_edited", short_title: null, first_plan: false })).toBe("PLAN UPDATED");
  });

  it("names a lot's rows by its short title, autopilot moves included", () => {
    expect(feedLabel({ kind: "autopilot_changed", short_title: "Wine Tasting", first_plan: false })).toBe("WINE TASTING");
    expect(feedLabel({ kind: "bid", short_title: "Chef’s Table", first_plan: false })).toBe("CHEF’S TABLE");
    expect(feedLabel({ kind: "paused", short_title: null, first_plan: false })).toBe("PAUSED");
  });
});
