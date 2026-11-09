/** What the routes of one lot share: finding it, and turning the engine's answers into HTTP. */
import { ApiError, enforceRateLimit, type PaddleSession } from "@/server/api";
import { EngineError, type Refusal } from "@/server/engine";
import { findLotRef, type LotRef } from "@/server/queries/lot-ref";
import { parseLotNumber } from "@/server/queries/request";
import { formatUsd } from "@/ui/format";

/** A person never gets near this; it only brakes a script filling event_log. */
export const LOT_ACTIONS_PER_MINUTE = { limit: 60, windowSeconds: 60 };

export async function requireLot(slug: string, number: string): Promise<LotRef> {
  const lotNumber = parseLotNumber(number);
  const lot = lotNumber === null ? null : await findLotRef(slug, lotNumber);
  if (!lot) throw new ApiError(404, "lot_not_found", "This lot doesn’t exist.");
  return lot;
}

export function enforceLotActionLimit(session: PaddleSession): Promise<void> {
  return enforceRateLimit(`lot-action:${session.paddleId}`, LOT_ACTIONS_PER_MINUTE);
}

/** The sentence a guest reads for each refusal. The numbers also go along as `details`. */
export function refusalMessage(refusal: Refusal): string {
  switch (refusal.reason) {
    case "lot_closed":
      return "Bidding on this lot has closed.";
    case "not_open":
      return "This lot isn’t open for bids yet.";
    case "below_minimum":
      return `The next minimum bid is ${formatUsd(refusal.minimumCents)}.`;
    case "no_hold":
      return "Set your bidding power before you bid.";
    case "over_bidding_power":
      return `This needs ${formatUsd(refusal.requiredCents)}, and you have ${formatUsd(refusal.availableCents)} left of ${formatUsd(refusal.holdCents)}.`;
  }
}

/** A refusal as the API answers it: 409, the engine's reason as the code, its numbers as the details. */
export function refusalError(refusal: Refusal): ApiError {
  return new ApiError(409, refusal.reason, refusalMessage(refusal), refusal);
}

/** The engine throws for ids that no longer exist: a demo deleted mid-request, say. */
export function engineFailure(error: unknown): unknown {
  if (error instanceof EngineError && (error.code === "lot_not_found" || error.code === "paddle_not_found")) {
    return new ApiError(404, error.code, "This lot doesn’t exist.");
  }
  return error;
}
