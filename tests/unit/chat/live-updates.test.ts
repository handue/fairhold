/** Which stream rows make the open panel read the chat again. */
import { describe, expect, it } from "vitest";

import type { StreamEvent } from "@/server/sse/types";
import { rowChangesChat } from "@/ui/glim/GlimLiveUpdates";

const row = (type: StreamEvent["type"], payload: object): StreamEvent => ({ id: "1", type, paddleId: null, at: 0, payload }) as StreamEvent;
const watched = new Set(["lot-7"]);

describe("rowChangesChat", () => {
  it("reads on Glim's rows, holds, closes and the event's status", () => {
    expect(rowChangesChat(row("glim", { kind: "chat_card", chatMessageId: "m", actionId: null }), watched)).toBe(true);
    expect(rowChangesChat(row("glim", { kind: "plan_status", planId: "p", status: "paused", version: 2 }), watched)).toBe(true);
    expect(rowChangesChat(row("hold", { holdId: "h", status: "authorized" }), watched)).toBe(true);
    expect(rowChangesChat(row("lot_closed", { kind: "lot_won", lotId: "l", lotNumber: 1, amountCents: 1 }), watched)).toBe(true);
    expect(rowChangesChat(row("event_status", { kind: "event_closed", status: "closed" }), watched)).toBe(true);
  });

  it("reads on a bid only for a lot on one of its cards", () => {
    expect(rowChangesChat(row("bid", { kind: "bids_placed", lotId: "lot-7" }), watched)).toBe(true);
    expect(rowChangesChat(row("bid", { kind: "bids_placed", lotId: "lot-9" }), watched)).toBe(false);
    expect(rowChangesChat(row("bid", { kind: "outbid", lotId: "lot-7" }), watched)).toBe(false);
  });

  it("ignores settlement rows", () => {
    expect(rowChangesChat(row("settlement", { kind: "settlement_finished", settlementId: "s", status: "done" }), watched)).toBe(false);
  });
});
