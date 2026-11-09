/** Glim's event cards: the approved sentences, the chips, and what the autopilot's own card already tells. */
import { describe, expect, it } from "vitest";

import { announcedByAutopilot, eventCardDraft, eventEyebrow, type EventFact, type EventFactPayload } from "@/server/chat/event-cards";
import { glimChip, glimLine } from "@/server/demo/glimLines";

const AT = new Date("2026-11-08T05:14:00Z");
const CONTEXT = { timezone: "America/Los_Angeles", shortTitle: "Chef’s Table" };
const LIMIT = { lotId: "lot-7", lotNumber: 7, limitId: "limit-1", owner: "glim", planItemId: null } as const;

const raised = (fields: Partial<Extract<EventFactPayload, { kind: "limit_raised" }>> = {}): EventFactPayload => ({
  ...LIMIT,
  kind: "limit_raised",
  amountCents: 38_000,
  limitCents: 38_000,
  triggerAmountCents: 36_000,
  raises: 1,
  opening: false,
  leading: true,
  ...fields,
});

const fact = (payload: EventFactPayload): EventFact => ({ id: "1", payload, createdAt: AT });
const draft = (payload: EventFactPayload) => eventCardDraft(fact(payload), CONTEXT);

describe("event card lines", () => {
  it("says 07's approved sentence, with its eyebrow and chip, when a raise reaches the limit", () => {
    const card = draft(raised());
    expect(card?.card).toEqual({
      type: "event",
      at: AT.toISOString(),
      eyebrow: "9:14 PM · CHEF’S TABLE",
      line: "Someone bid $360. I raised to $380, your limit for this lot.",
      chip: { kind: "winning", amountCents: 38_000 },
    });
    expect(card?.action).toMatchObject({ kind: "raise", amountCents: 38_000, limitCents: 38_000, triggerAmountCents: 36_000, chip: "winning" });
  });

  it("leaves the limit out below it, and says who when there is no amount to name", () => {
    expect(draft(raised({ amountCents: 10_000, limitCents: 12_000, triggerAmountCents: 9_500 }))?.card.line).toBe("Someone bid $95. I raised to $100.");
    expect(draft(raised({ amountCents: 10_000, limitCents: 12_000, triggerAmountCents: null }))?.card.line).toBe("Someone outbid you. I raised to $100.");
  });

  it("calls an opening bid what 10 calls it", () => {
    const card = draft(raised({ amountCents: 9_000, limitCents: 12_000, triggerAmountCents: 8_500, opening: true }));
    expect(card?.card.line).toBe("I bid $90 for you. I’ll go up to $120.");
    expect(card?.card.chip).toEqual({ kind: "winning", amountCents: 9_000 });
    expect(card?.action.kind).toBe("bid");
  });

  it("draws no winning chip on a raise another limit answered in the same action", () => {
    const card = draft(raised({ leading: false }));
    expect(card?.card.chip).toBeNull();
    expect(card?.action.chip).toBe("none");
  });

  it("says when a bid passes the limit, with no chip", () => {
    const card = draft({ ...LIMIT, kind: "limit_exhausted", limitCents: 38_000, currentBidCents: 40_000 });
    expect(card?.card.line).toBe("Someone bid $400, over your $380 limit.");
    expect(card?.card.chip).toBeNull();
    expect(card?.action).toMatchObject({ kind: "limit_reached", chip: "none", triggerAmountCents: 40_000 });
  });

  it("closes a won lot with design/22's lime Won chip, and a lost one with 10's grey chip", () => {
    const won = draft({ kind: "lot_won", lotId: "lot-12", lotNumber: 12, amountCents: 9_000 });
    expect(won?.card.line).toBe("Bidding closed. You won at $90.");
    expect(won?.card.chip).toEqual({ kind: "won", amountCents: 9_000 });
    // No new enum value: the action keeps "closed", and the card's chip derives from lot_won.
    expect(won?.action).toMatchObject({ kind: "lot_won", chip: "closed" });
    const lost = draft({ kind: "lot_lost", lotId: "lot-21", lotNumber: 21, winningCents: 9_500 });
    expect(lost?.card.chip).toEqual({ kind: "closed" });
    expect(lost?.card.line).toBe("Bidding closed at $95. You didn’t win, so you won’t be charged.");
    expect(lost?.action.kind).toBe("lot_lost");
    expect(draft({ kind: "lot_lost", lotId: "lot-21", lotNumber: 21, winningCents: null })?.card.line).toBe(
      "Bidding closed. You didn’t win, so you won’t be charged.",
    );
  });

  it("matches the seeded feed's wording, so 07 and 10 read the same", () => {
    const line = (kind: Parameters<typeof glimLine>[0]["kind"], amountCents: number, limitCents: number | null, triggerCents: number | null = null) =>
      glimLine({ kind, amountCents, limitCents, triggerCents, planItems: [] });
    expect(draft(raised())?.action.message).toBe(line("raise", 38_000, 38_000, 36_000));
    expect(draft(raised({ opening: true, amountCents: 9_000, limitCents: 12_000 }))?.action.message).toBe(line("bid", 9_000, 12_000));
    expect(draft({ ...LIMIT, kind: "limit_exhausted", limitCents: 38_000, currentBidCents: 40_000 })?.action.message).toBe(line("limit_reached", 40_000, 38_000));
    expect(draft({ kind: "lot_won", lotId: "l", lotNumber: 1, amountCents: 9_000 })?.action.message).toBe(line("lot_won", 9_000, null));
    expect(draft({ kind: "lot_lost", lotId: "l", lotNumber: 1, winningCents: 9_500 })?.action.message).toBe(line("lot_lost", 9_500, null));
    expect(draft(raised())?.action.chip).toBe(glimChip("raise"));
    expect(draft({ kind: "lot_won", lotId: "l", lotNumber: 1, amountCents: 9_000 })?.action.chip).toBe(glimChip("lot_won"));
  });

  it("says nothing about a guest's own maximum", () => {
    expect(draft(raised({ owner: "guest_max" }))).toBeNull();
    expect(draft({ ...LIMIT, owner: "guest_max", kind: "limit_exhausted", limitCents: 1, currentBidCents: 2 })).toBeNull();
  });

  it("puts the event's own time zone in the eyebrow", () => {
    expect(eventEyebrow(AT, "America/New_York", "Paused")).toBe("12:14 AM · PAUSED");
  });
});

describe("announcedByAutopilot", () => {
  const announcements = [{ limitIds: ["limit-1"], transaction: "t1" }];
  const row = (payload: EventFactPayload, transaction: string) => ({ ...fact(payload), transaction });

  it("skips the opening bid of a limit the run created", () => {
    expect(announcedByAutopilot(row(raised({ opening: true }), "t1"), announcements)).toBe(true);
  });

  it("skips that limit being outbid in the same transaction", () => {
    expect(announcedByAutopilot(row({ ...LIMIT, kind: "limit_exhausted", limitCents: 1, currentBidCents: 2 }, "t1"), announcements)).toBe(true);
  });

  it("keeps what happens to the limit later", () => {
    expect(announcedByAutopilot(row(raised(), "t2"), announcements)).toBe(false);
    expect(announcedByAutopilot(row({ ...LIMIT, kind: "limit_exhausted", limitCents: 1, currentBidCents: 2 }, "t2"), announcements)).toBe(false);
  });

  it("keeps every other limit's facts, and lots closing", () => {
    expect(announcedByAutopilot(row(raised({ opening: true, limitId: "limit-2" }), "t1"), announcements)).toBe(false);
    expect(announcedByAutopilot(row({ kind: "lot_won", lotId: "l", lotNumber: 1, amountCents: 1 }, "t1"), announcements)).toBe(false);
  });
});
