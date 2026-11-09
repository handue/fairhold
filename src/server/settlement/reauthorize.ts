/**
 * Reauthorizing a hold past PayPal's 3-day honor period, for the checks before charging and for the
 * sweep. The call targets the original id (a reauthorized id answers REAUTHORIZATION_NOT_SUPPORTED)
 * and returns a new id, which becomes the hold's current one, the target of capture. Demo holds
 * never get that old.
 */
import { PaypalError } from "@/server/paypal/errors";
import { HONOR_PERIOD_MS } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { HoldKind } from "@/server/paypal/payments";

import { settlementTransaction, type SettlementDependencies } from "./dependencies";

export interface ReauthorizableHold {
  id: string;
  paddleId: string;
  kind: HoldKind;
  amountCents: number;
  originalAuthorizationId: string;
  authorizedAt: Date | null;
}

export type ReauthorizeOutcome =
  | { kind: "reauthorized"; authorizationId: string }
  /** PayPal counts the honor period its own way; the id in place stays good for capture. */
  | { kind: "too_soon" }
  /** The hold stopped being authorized while PayPal was answering. */
  | { kind: "hold_changed" };

/**
 * Which round this is: one per honor period the hold has outlived. A retry inside a round replays
 * PayPal's stored answer, while the round after it, 3 days on, is a new request and gets a new id.
 */
export function reauthorizationRound(authorizedAt: Date | null, now: Date): number {
  if (!authorizedAt) return 1;
  return Math.max(1, Math.floor((now.getTime() - authorizedAt.getTime()) / HONOR_PERIOD_MS));
}

export async function reauthorizeHold(
  hold: ReauthorizableHold,
  dependencies: SettlementDependencies,
): Promise<ReauthorizeOutcome> {
  let renewed;
  try {
    renewed = await dependencies.paymentsFor(hold.kind).reauthorize({
      authorizationId: hold.originalAuthorizationId,
      amountCents: hold.amountCents,
      idempotencyKey: paypalRequestId("reauthorize", hold.id, reauthorizationRound(hold.authorizedAt, dependencies.now())),
    });
  } catch (error) {
    if (error instanceof PaypalError && error.is("REAUTHORIZATION_TOO_SOON")) return { kind: "too_soon" };
    throw error;
  }
  if (renewed.status !== "CREATED") {
    throw new PaypalError({
      operation: "reauthorize",
      code: `AUTHORIZATION_${renewed.status}`,
      debugId: renewed.debugId,
    });
  }

  const renewedAt = renewed.createdAt ?? dependencies.now();
  const changed = await settlementTransaction(dependencies.pool, async (client) => {
    await client.query("select id from paddles where id = $1 for no key update", [hold.paddleId]);
    const { rowCount } = await client.query(
      `update holds set
         current_authorization_id = $2,
         reauthorized_at = $3,
         honor_until = $4,
         expires_at = coalesce($5, expires_at),
         paypal_debug_id = coalesce($6, paypal_debug_id),
         last_synced_at = clock_timestamp()
       where id = $1 and status = 'authorized'`,
      [
        hold.id,
        renewed.authorizationId,
        renewedAt,
        new Date(renewedAt.getTime() + HONOR_PERIOD_MS),
        renewed.expiresAt ?? null,
        renewed.debugId ?? null,
      ],
    );
    return rowCount === 1;
  });
  return changed ? { kind: "reauthorized", authorizationId: renewed.authorizationId } : { kind: "hold_changed" };
}
