import type { Cents, EventStatus, LotStatus } from "./types";

export const REFUSAL_REASONS = [
  "lot_closed",
  "not_open",
  "below_minimum",
  "no_hold",
  "over_bidding_power",
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/**
 * Why the engine said no, with the numbers the UI needs to explain it. Refusals are expected
 * outcomes, returned rather than thrown; nothing is written when one is returned.
 */
export type Refusal =
  | {
      reason: "lot_closed";
      lotId: string;
      closesAt: Date;
      closedAt: Date | null;
    }
  | {
      reason: "not_open";
      lotId: string;
      lotStatus: LotStatus;
      eventStatus: EventStatus;
    }
  | {
      reason: "below_minimum";
      lotId: string;
      minimumCents: Cents;
      amountCents: Cents;
    }
  | {
      reason: "no_hold";
      paddleId: string;
    }
  | {
      reason: "over_bidding_power";
      paddleId: string;
      /** The lots the refused action would have committed money on. */
      lotIds: string[];
      holdCents: Cents;
      /** Already committed on every other lot (leading bids, limits at their max, won lots). */
      committedElsewhereCents: Cents;
      /** holdCents minus committedElsewhereCents: the most this action could commit. */
      availableCents: Cents;
      /** What the action needs committed on its lots. */
      requiredCents: Cents;
      /** How much more bidding power the action needs (requiredCents minus availableCents). */
      shortfallCents: Cents;
    };

export type Outcome<T extends object> = ({ ok: true } & T) | { ok: false; refusal: Refusal };

export function refused(refusal: Refusal): { ok: false; refusal: Refusal } {
  return { ok: false, refusal };
}
