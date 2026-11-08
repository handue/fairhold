import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as schema from "@/server/db/schema";
import { paypalRequestId } from "@/server/paypal/idempotency";
import {
  attemptNumber,
  backoffSeconds,
  invoiceIdFor,
  itemRequestId,
  noteToPayerFor,
  planSettlement,
  triesAfterRetry,
  triesInAttempt,
  TRIES_PER_ATTEMPT,
  type PlanHold,
} from "@/server/settlement/plan";
import { SETTLEMENT_ACTIONS, SETTLEMENT_ITEM_STATUSES, SETTLEMENT_STATUSES } from "@/server/settlement/types";

const hold = (paddleNumber: number, kind: PlanHold["kind"], holdCents: number): PlanHold => ({
  paddleId: `paddle-${paddleNumber}`,
  paddleNumber,
  holdId: `hold-${paddleNumber}`,
  kind,
  holdCents,
});

describe("the settlement's enums", () => {
  it("agree with the schema", () => {
    expect([...SETTLEMENT_STATUSES]).toEqual(schema.settlementStatus.enumValues);
    expect([...SETTLEMENT_ACTIONS]).toEqual(schema.settlementAction.enumValues);
    expect([...SETTLEMENT_ITEM_STATUSES]).toEqual(schema.settlementItemStatus.enumValues);
  });
});

describe("planSettlement", () => {
  it("captures a real winner, voids a real non-winner, and simulates a simulated guest either way", () => {
    const planned = planSettlement(
      [hold(142, "paypal", 50_000), hold(143, "paypal", 25_000), hold(175, "simulated", 200_000), hold(176, "simulated", 50_000)],
      new Map([
        ["paddle-142", 47_000],
        ["paddle-175", 145_000],
      ]),
    );
    if (!planned.ok) throw new Error("expected a plan");
    expect(planned.plan.items.map((item) => [item.paddleNumber, item.action, item.amountCents, item.releasedCents])).toEqual([
      [142, "capture", 47_000, 3_000],
      [143, "void", 0, 25_000],
      [175, "simulate", 145_000, 55_000],
      [176, "simulate", 0, 50_000],
    ]);
    expect(planned.plan).toMatchObject({ winners: 2, nonWinners: 2, toChargeCents: 192_000, toReleaseCents: 133_000 });
  });

  it("captures a winner's whole hold, with nothing left to release", () => {
    const planned = planSettlement([hold(142, "paypal", 50_000)], new Map([["paddle-142", 50_000]]));
    expect(planned).toMatchObject({ ok: true, plan: { items: [{ action: "capture", amountCents: 50_000, releasedCents: 0 }] } });
  });

  it("refuses a total over its hold, and a winner with no hold", () => {
    expect(planSettlement([hold(142, "paypal", 50_000)], new Map([["paddle-142", 50_001]]))).toEqual({
      ok: false,
      problems: [{ paddleId: "paddle-142", code: "over_hold" }],
    });
    expect(planSettlement([], new Map([["paddle-142", 100]]))).toEqual({
      ok: false,
      problems: [{ paddleId: "paddle-142", code: "no_hold" }],
    });
  });

  it("never plans a capture past its hold, and accounts for every cent held", () => {
    const guest = fc.record({
      kind: fc.constantFrom<PlanHold["kind"]>("paypal", "simulated"),
      holdCents: fc.integer({ min: 1, max: 5_000_000 }),
      wonCents: fc.integer({ min: 0, max: 5_000_000 }),
    });
    fc.assert(
      fc.property(fc.array(guest, { maxLength: 40 }), (guests) => {
        const holds = guests.map((item, index) => hold(index + 1, item.kind, item.holdCents));
        const wins = new Map(guests.flatMap((item, index) => (item.wonCents > 0 ? ([[`paddle-${index + 1}`, item.wonCents]] as const) : [])));
        const planned = planSettlement(holds, wins);
        const overdrawn = guests.some((item) => item.wonCents > item.holdCents);
        expect(planned.ok).toBe(!overdrawn);
        if (!planned.ok) return;
        for (const [index, item] of planned.plan.items.entries()) {
          const source = guests[index];
          expect(item.amountCents).toBeLessThanOrEqual(source?.holdCents ?? 0);
          expect(item.amountCents + item.releasedCents).toBe(source?.holdCents);
          expect(item.amountCents).toBe(source?.wonCents);
          if (source?.kind === "simulated") expect(item.action).toBe("simulate");
          else expect(item.action).toBe(item.amountCents > 0 ? "capture" : "void");
        }
        expect(planned.plan.toChargeCents + planned.plan.toReleaseCents).toBe(guests.reduce((sum, item) => sum + item.holdCents, 0));
        expect(planned.plan.winners + planned.plan.nonWinners).toBe(guests.length);
      }),
    );
  });
});

describe("what PayPal sees", () => {
  it("has one invoice id per paddle and event, within PayPal's 127 characters", () => {
    const event = "6f1c2b3a-1111-4222-8333-444455556666";
    expect(invoiceIdFor(event, 142)).toBe(`FH-${event}-142`);
    expect(invoiceIdFor(event, 142)).not.toBe(invoiceIdFor(event, 143));
    expect(invoiceIdFor(event, 142)).not.toBe(invoiceIdFor("6f1c2b3a-1111-4222-8333-444455556667", 142));
    expect(invoiceIdFor(event, 999_999).length).toBeLessThanOrEqual(127);
  });

  it("thanks the buyer within 255 characters and says nothing about tax", () => {
    expect(noteToPayerFor("Riverside Animal Shelter")).toBe("Thank you for supporting Riverside Animal Shelter.");
    expect(noteToPayerFor("x".repeat(400)).length).toBe(255);
    expect(noteToPayerFor("Riverside").toLowerCase()).not.toMatch(/tax|irs|fmv|guarantee/);
  });

  it("derives a request id from the item and the attempt", () => {
    expect(itemRequestId("capture", "item-1")).toBe(paypalRequestId("capture", "item-1"));
    expect(itemRequestId("void", "item-1")).toBe(paypalRequestId("void", "item-1"));
    expect(itemRequestId("capture", "item-1", 2)).toBe(paypalRequestId("capture", "item-1", 2));
    expect(itemRequestId("capture", "item-1", 2)).not.toBe(itemRequestId("capture", "item-1"));
    expect(itemRequestId("capture", "item-1")).not.toBe(itemRequestId("capture", "item-2"));
    expect(itemRequestId("simulate", "item-1")).toBeNull();
  });
});

describe("counting tries", () => {
  it("reads the attempt and its tries from the one column", () => {
    const table = [
      [0, 1, 0],
      [1, 1, 1],
      [TRIES_PER_ATTEMPT, 1, TRIES_PER_ATTEMPT],
      [TRIES_PER_ATTEMPT + 1, 2, 1],
      [2 * TRIES_PER_ATTEMPT, 2, TRIES_PER_ATTEMPT],
    ];
    for (const [tries, attempt, used] of table) {
      expect(attemptNumber(tries ?? 0)).toBe(attempt);
      expect(triesInAttempt(tries ?? 0)).toBe(used);
    }
  });

  it("opens a fresh attempt with a retry, from any point in the old one", () => {
    for (const tries of [1, 2, 3, 4, 5, 6, 9, 10, 11]) {
      const next = triesAfterRetry(tries) + 1;
      expect(attemptNumber(next)).toBe(attemptNumber(tries) + 1);
      expect(triesInAttempt(next)).toBe(1);
    }
  });

  it("backs off further each time, and stays at the longest wait", () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffSeconds)).toEqual([2, 8, 30, 120, 120, 120]);
  });
});
