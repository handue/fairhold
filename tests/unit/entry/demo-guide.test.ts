import { describe, expect, it } from "vitest";

import type { StreamEvent } from "@/server/sse/types";
import { controlDoneLine, demoControlPath } from "@/ui/demo/controls";
import type { GuideProgress } from "@/ui/demo/demo-state";
import { guideView, stepDoneBy, withStepDone } from "@/ui/demo/guide";

const NONE: GuideProgress = { power: false, heart: false, bid: false, close: false, charge: false };
const PADDLE = { paddleId: "paddle-142", paddleNumber: 142 };

function row<Row extends StreamEvent>(value: Omit<Row, "id" | "at">): StreamEvent {
  return { id: "1", at: 0, ...value } as StreamEvent;
}

describe("the demo guide (design/18 with design/21's V5 step)", () => {
  it("starts at step 1 of 5, with the five steps as drawn", () => {
    const view = guideView(NONE);
    expect(view).toMatchObject({ position: 1, total: 5 });
    expect(view.steps.map((step) => step.label)).toEqual([
      "Set bidding power",
      "Heart a lot you’d also like.",
      "Bid, or let Glim bid",
      "Close bidding",
      "Charge winners and see your receipt",
    ]);
    expect(view.steps.map((step) => step.state)).toEqual(["now", "next", "next", "next", "next"]);
  });

  it("draws V5's second sentence only on the heart step while it is now", () => {
    expect(guideView(NONE).steps.every((step) => step.detail === null)).toBe(true);
    const heartNow = guideView({ ...NONE, power: true });
    expect(heartNow.position).toBe(2);
    expect(heartNow.steps[1]).toMatchObject({
      state: "now",
      detail: "If your top lot gets away, Glim can move your money there.",
    });
  });

  it("never goes back: bidding before hearting makes step 4 now and leaves step 2 as it was", () => {
    const view = guideView({ ...NONE, power: true, bid: true });
    expect(view.position).toBe(4);
    expect(view.steps.map((step) => step.state)).toEqual(["done", "next", "done", "now", "next"]);
  });

  it("reads 5 of 5 with every step done", () => {
    const view = guideView({ power: true, heart: true, bid: true, close: true, charge: true });
    expect(view.position).toBe(5);
    expect(view.steps.every((step) => step.state === "done")).toBe(true);
  });

  it("moves on from this paddle's rows only", () => {
    expect(stepDoneBy(row({ type: "hold", paddleId: "paddle-142", payload: { holdId: "h", status: "authorized" } }), PADDLE)).toBe("power");
    // An organizer's stream carries every paddle's hold rows.
    expect(stepDoneBy(row({ type: "hold", paddleId: "paddle-187", payload: { holdId: "h", status: "authorized" } }), PADDLE)).toBeNull();
    expect(stepDoneBy(row({ type: "hold", paddleId: "paddle-142", payload: { holdId: "h", status: "pending_approval" } }), PADDLE)).toBeNull();
    expect(
      stepDoneBy(
        row({ type: "bid", paddleId: "paddle-142", payload: { kind: "favorite_changed", lotId: "l", lotNumber: 9, isFavorite: true } }),
        PADDLE,
      ),
    ).toBe("heart");
    expect(
      stepDoneBy(
        row({ type: "bid", paddleId: "paddle-142", payload: { kind: "favorite_changed", lotId: "l", lotNumber: 9, isFavorite: false } }),
        PADDLE,
      ),
    ).toBeNull();
  });

  it("counts a bid by this paddle, by hand or by Glim, and Glim's plan starting", () => {
    const bids = (paddleNumber: number) =>
      row({
        type: "bid",
        paddleId: null,
        payload: {
          kind: "bids_placed",
          lotId: "l",
          lotNumber: 12,
          bids: [{ bidId: "b", paddleId: "p", paddleNumber, amountCents: 90_00, source: "glim" }],
          currentBidCents: 90_00,
          bidCount: 5,
          highPaddleId: "p",
          highPaddleNumber: paddleNumber,
          nextMinimumCents: 95_00,
        },
      });
    expect(stepDoneBy(bids(142), PADDLE)).toBe("bid");
    expect(stepDoneBy(bids(117), PADDLE)).toBeNull();
    expect(
      stepDoneBy(row({ type: "glim", paddleId: "paddle-142", payload: { kind: "plan_status", planId: "p", status: "active", version: 1 } }), PADDLE),
    ).toBe("bid");
  });

  it("closes and charges from the event's own rows; charging implies closing", () => {
    expect(stepDoneBy(row({ type: "event_status", paddleId: null, payload: { kind: "event_closed", status: "closed" } }), PADDLE)).toBe("close");
    expect(stepDoneBy(row({ type: "event_status", paddleId: null, payload: { kind: "event_settled", status: "settled" } }), PADDLE)).toBe("charge");
    expect(withStepDone(NONE, "charge")).toMatchObject({ close: true, charge: true });
    const done = withStepDone(NONE, "power");
    expect(withStepDone(done, "power")).toBe(done);
  });
});

describe("the demo controls' lines", () => {
  it("calls the existing route", () => {
    expect(demoControlPath("gala-abc", "close-next-lot")).toBe("/api/events/gala-abc/demo/close-next-lot");
  });

  it("says what a control did, in the gala's time zone", () => {
    expect(controlDoneLine({ control: "close-next-lot", answer: { lotNumber: 3, shortTitle: "Cabin Stay", openLots: 23 } }, "UTC")).toBe(
      "Lot 03, Cabin Stay, is closed. 23 lots are still open.",
    );
    expect(controlDoneLine({ control: "close-next-lot", answer: { lotNumber: 7, shortTitle: "Chef’s Table", openLots: 1 } }, "UTC")).toBe(
      "Lot 07, Chef’s Table, is closed. 1 lot is still open.",
    );
    expect(controlDoneLine({ control: "close-next-lot", answer: { lotNumber: 7, shortTitle: "Chef’s Table", openLots: 0 } }, "UTC")).toBe(
      "Lot 07, Chef’s Table, is closed. No lots are open now.",
    );
    expect(
      controlDoneLine({ control: "add-time", answer: { closesAt: "2026-11-10T05:40:00.000Z" } }, "America/Los_Angeles"),
    ).toBe("Bidding now closes at 9:40 PM.");
  });
});
