import { describe, expect, it } from "vitest";

import type { ReceiptGlimView, ReceiptLot } from "@/server/queries/receipt-view";

import { keepLastWords } from "../paddle/text";
import { listNote, projectorBubble, roomLabel, shortClock, trustLines } from "../projector/copy";
import { bidByLine, bidByText, captionLines, charityLines, glimSay, receiptBubble, receiptDate, receiptFileName, receiptTitle } from "./copy";

const TZ = "America/Los_Angeles";
const CLOSE = Date.parse("2026-11-08T05:30:00Z");

const glim = (overrides: Partial<ReceiptGlimView> = {}): ReceiptGlimView => ({
  bidsPlaced: 2,
  allWithinLimits: true,
  singleLimitCents: null,
  planLots: 2,
  planLotsWon: 2,
  offDutyAt: CLOSE,
  ...overrides,
});

const lot = (overrides: Partial<ReceiptLot> = {}): ReceiptLot => ({
  lotId: "lot",
  number: 7,
  category: "dining",
  title: "Chef’s Table Dinner for Four",
  coverDrawing: null,
  closedAt: CLOSE,
  paidCents: 38_000,
  estimatedValueCents: 48_000,
  deductibleCents: 0,
  bidBy: "glim",
  limitCents: 38_000,
  lastBidCents: null,
  soldCents: null,
  ...overrides,
});

describe("receipt copy (design/25)", () => {
  it("says what Glim did, as 25 draws it", () => {
    expect(glimSay(glim(), true)).toEqual(["I placed 2 bids for you, each within your limits.", "You won both lots in your plan."]);
    expect(glimSay(glim({ bidsPlaced: 1, singleLimitCents: 38_000, planLots: 1, planLotsWon: 0 }), false)).toEqual([
      "I placed 1 bid for you, within your $380 limit.",
      "Another bidder went past it, so you weren’t charged.",
    ]);
    expect(glimSay(glim({ planLots: 3, planLotsWon: 1 }), true)?.[1]).toBe("You won 1 of the 3 lots in your plan.");
    expect(glimSay(glim({ planLots: 2, planLotsWon: 0 }), true)?.[1]).toBe("Other bidders went past your limits.");
    expect(glimSay(null, true)).toBeNull();
  });

  it("never claims the limits held when the check says otherwise", () => {
    expect(glimSay(glim({ allWithinLimits: false, singleLimitCents: 38_000 }), true)?.[0]).toBe("I placed 2 bids for you.");
  });

  it("writes who bid and how close to the limit", () => {
    expect(bidByLine(lot(), true)).toEqual({ glim: true, parts: ["Bid by Glim · at your ", { cents: 38_000 }, " limit"] });
    expect(bidByLine(lot({ paidCents: 9_000, limitCents: 12_000 }), true)?.parts).toEqual(["Bid by Glim · ", { cents: 3_000 }, " under your ", { cents: 12_000 }, " limit"]);
    expect(bidByLine(lot({ bidBy: "guest", limitCents: null, paidCents: 0, lastBidCents: 9_000 }), false)).toEqual({ glim: false, parts: ["Your last bid · ", { cents: 9_000 }] });
    expect(bidByText(lot({ paidCents: 9_000, limitCents: 12_000 }))).toBe("Bid by Glim, $30 under your $120 limit");
  });

  it("captions each state in its own tense", () => {
    const event = { timeZone: TZ, closesAt: CLOSE };
    const won = [lot(), lot()];
    expect(captionLines({ phase: "paid", won, releaseCents: 3_000, receipt: { number: "1107-142", issuedAt: CLOSE, captureId: "X" }, releasedAt: null, event: event as never })).toEqual([
      "One payment at 9:30 PM for the 2 lots you won.",
      "The rest of your hold was released at the same time.",
    ]);
    expect(captionLines({ phase: "pending", won, releaseCents: 3_000, receipt: null, releasedAt: null, event: event as never })[0]).toBe(
      "One payment for the 2 lots you won, when the organizer charges.",
    );
    expect(captionLines({ phase: "released", won: [], releaseCents: 50_000, receipt: null, releasedAt: null, event: event as never })).toEqual([
      "You won no lots, so you were never charged.",
      "Your whole hold was released at 9:30 PM.",
    ]);
  });

  it("says nothing was held for a guest who never set bidding power", () => {
    const event = { timeZone: TZ, closesAt: CLOSE };
    const base = { won: [], releaseCents: 0, receipt: null, releasedAt: null, event: event as never, hold: null };
    expect(captionLines({ ...base, phase: "released" })).toEqual([
      "You won no lots, so you were never charged.",
      "You didn’t set bidding power, so nothing was held.",
    ]);
    expect(captionLines({ ...base, phase: "release_pending" })[1]).toBe("You didn’t set bidding power, so nothing is held.");
  });

  it("titles, bubbles and the sandbox labels (decision C5)", () => {
    expect(receiptTitle("paid", "1107-142")).toBe("Receipt 1107-142");
    expect(receiptTitle("pending", null)).toBe("Receipt pending");
    expect(receiptTitle("released", null)).toBe("Hold released");
    expect(receiptBubble("pending", null)).toEqual({ title: "Almost there", body: "Your receipt appears when winners are charged." });
    expect(receiptBubble("released", null)?.body).toBe("Your hold is already released.");
    expect(charityLines({ charityName: "Riverside Animal Shelter", charityEin: "12-3456789", charityIs501c3: true })).toEqual([
      "Riverside Animal Shelter is a made-up charity for this demo.",
      "Its 501(c)(3) status and EIN 12-3456789 are placeholders.",
    ]);
    expect(receiptDate(CLOSE, TZ, "short")).toBe("Sat, November 7, 2026 · 9:30 PM");
    expect(receiptDate(CLOSE, TZ, "long")).toBe("Saturday, November 7, 2026 · 9:30 PM");
    expect(receiptFileName("1107-142")).toBe("fairhold-sandbox-receipt-1107-142");
  });

  it("never says what C5 took out", () => {
    const words = [
      ...glimSay(glim(), true)!,
      ...charityLines({ charityName: "Riverside Animal Shelter", charityEin: "12-3456789", charityIs501c3: true }),
      receiptBubble("paid", "Show this receipt at the front desk by 10 PM.")?.body ?? "",
    ].join(" ");
    expect(words).not.toMatch(/tax records|in exchange for your payment|FMV|fair market value|IRS|guaranteed/i);
  });
});

describe("projector copy (design/26)", () => {
  it("labels the room, the list and Glim's bubble", () => {
    expect(roomLabel({ phase: "live", lotCount: 24, soldCount: 0, bidderCount: 86 })).toBe("24 lots · 86 bidders");
    expect(roomLabel({ phase: "before", lotCount: 24, soldCount: 0, bidderCount: 86 })).toBe("24 lots");
    expect(roomLabel({ phase: "after", lotCount: 24, soldCount: 23, bidderCount: 86 })).toBe("23 of 24 lots sold · 86 bidders");
    expect(listNote({ kind: "more", count: 16, at: CLOSE, sameTime: true }, TZ)).toBe("16 more lots at 9:30 PM");
    expect(listNote({ kind: "more", count: 20, at: CLOSE, sameTime: false }, TZ)).toBe("20 more lots by 9:30 PM");
    expect(listNote({ kind: "last", count: 3 }, TZ)).toBe("Last 3 lots");
    expect(listNote({ kind: "last", count: 1 }, TZ)).toBe("Last lot");
    expect(listNote({ kind: "sold", count: 19 }, TZ)).toBe("19 more lots sold");
    expect(projectorBubble({ phase: "live", glim: { guests: 29, bids: 84, withinLimits: true } })).toEqual({
      title: "I’m bidding for 29 guests",
      body: "84 bids, all within their limits.",
    });
    expect(projectorBubble({ phase: "after", glim: { guests: 31, bids: 96, withinLimits: true } })?.title).toBe("I bid for 31 guests");
    expect(projectorBubble({ phase: "live", glim: { guests: 0, bids: 0, withinLimits: true } })?.title).toBe("Want me to bid for you?");
    expect(projectorBubble({ phase: "after", glim: { guests: 0, bids: 0, withinLimits: true } })).toBeNull();
  });

  it("rounds a lot's close to the minute and drops PM before opening", () => {
    expect(shortClock(Date.parse("2026-11-08T05:05:55Z"), TZ)).toBe("9:06");
    expect(shortClock(Date.parse("2026-11-08T05:07:30Z"), TZ)).toBe("9:08");
  });

  it("says 'Your bids' in a demo (decision C6) and the pickup from the room's side after the close", () => {
    expect(trustLines({ phase: "live", isDemo: true, pickupNote: null })[0]).toBe("Your bids are backed by bidding power held with PayPal.");
    expect(trustLines({ phase: "live", isDemo: false, pickupNote: null })[0]).toBe("Every bid is backed by bidding power held with PayPal.");
    expect(trustLines({ phase: "after", isDemo: true, pickupNote: "Show this receipt at the front desk by 10 PM." })).toEqual([
      "Winners pay only for the lots they won.",
      "Show your receipt at the front desk by 10 PM.",
    ]);
  });
});

describe("keepLastWords", () => {
  it("keeps the last five words of a line together, as the approved feed does", () => {
    expect(keepLastWords("Someone bid $360. I raised to $380, your limit for this lot.")).toBe(
      "Someone bid $360. I raised to $380, your limit for this lot.",
    );
    expect(keepLastWords("Short line here.")).toBe("Short line here.");
  });
});
