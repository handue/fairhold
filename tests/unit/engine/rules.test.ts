import { describe, expect, it } from "vitest";

import { biddingGate, commitmentCents, nextMinimumCents } from "@/server/engine/rules";
import type { LotState } from "@/server/engine/types";

const lot = (overrides: Partial<LotState> = {}): LotState => ({
  id: "lot-7",
  eventId: "event-1",
  number: 7,
  status: "open",
  eventStatus: "live",
  startingBidCents: 10_000,
  minRaiseCents: 2_000,
  currentBidCents: null,
  bidCount: 0,
  highPaddleId: null,
  highBidSource: null,
  closesAt: new Date("2026-11-07T05:30:00Z"),
  pastClose: false,
  winningPaddleId: null,
  winningCents: null,
  closedAt: null,
  ...overrides,
});

describe("nextMinimumCents", () => {
  it("is the starting bid while the lot has no bids", () => {
    expect(nextMinimumCents(lot())).toBe(10_000);
  });

  it("is the current bid plus the minimum raise once someone leads", () => {
    expect(nextMinimumCents(lot({ currentBidCents: 30_000, highPaddleId: "p-88" }))).toBe(32_000);
  });

  it("treats a lot without a leader as unbid, whatever current_bid_cents holds", () => {
    expect(nextMinimumCents(lot({ currentBidCents: 0, highPaddleId: null }))).toBe(10_000);
  });
});

describe("biddingGate", () => {
  it("lets an open lot of a live event before closes_at take bids", () => {
    expect(biddingGate(lot())).toBeNull();
  });

  it("refuses at or after closes_at even while the lot still says open", () => {
    expect(biddingGate(lot({ pastClose: true }))).toMatchObject({ reason: "lot_closed", lotId: "lot-7" });
  });

  it("refuses closed lots and lots of events past live", () => {
    expect(biddingGate(lot({ status: "closed" }))?.reason).toBe("lot_closed");
    for (const eventStatus of ["closed", "settling", "settled"] as const) {
      expect(biddingGate(lot({ eventStatus }))?.reason).toBe("lot_closed");
    }
  });

  it("reports lots and events that have not opened", () => {
    expect(biddingGate(lot({ status: "draft" }))).toMatchObject({ reason: "not_open", lotStatus: "draft" });
    expect(biddingGate(lot({ eventStatus: "scheduled" }))).toMatchObject({
      reason: "not_open",
      eventStatus: "scheduled",
    });
  });
});

describe("commitmentCents", () => {
  const open = { status: "open" as const, winningPaddleId: null, winningCents: null };

  it("counts an active limit at its max, whether or not the paddle leads", () => {
    expect(commitmentCents({ ...open, highPaddleId: "jamie", currentBidCents: 9_000 }, "jamie", 12_000)).toBe(12_000);
    expect(commitmentCents({ ...open, highPaddleId: "rival", currentBidCents: 9_000 }, "jamie", 12_000)).toBe(12_000);
  });

  it("counts the leading bid without a limit, and nothing when outbid", () => {
    expect(commitmentCents({ ...open, highPaddleId: "jamie", currentBidCents: 32_000 }, "jamie", null)).toBe(32_000);
    expect(commitmentCents({ ...open, highPaddleId: "rival", currentBidCents: 32_000 }, "jamie", null)).toBe(0);
  });

  it("counts a manual bid above the paddle's own limit at the bid", () => {
    expect(commitmentCents({ ...open, highPaddleId: "jamie", currentBidCents: 35_000 }, "jamie", 30_000)).toBe(35_000);
  });

  it("counts a closed lot at the amount won, and nothing for the paddles that lost", () => {
    const closed = {
      status: "closed" as const,
      highPaddleId: "jamie",
      currentBidCents: 38_000,
      winningPaddleId: "jamie",
      winningCents: 38_000,
    };
    expect(commitmentCents(closed, "jamie", null)).toBe(38_000);
    expect(commitmentCents(closed, "rival", 50_000)).toBe(0);
  });
});
