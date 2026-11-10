/**
 * Which hold is, or was, a paddle's bidding power, for the pages that tell a guest what is held.
 *
 * A PayPal approval can be authorized by PayPal and still never become the bidding power: it came
 * after bidding ended, it was not a raise over the hold in place, or its window had been canceled
 * here (src/server/paypal/hold-store.ts). Its row keeps PayPal's authorization until the void, so it
 * has authorized_at set and is often the paddle's newest row, first `replaced` and then `voided`.
 * No read may take it for the guest's hold. A hold a raise displaced is also `replaced`, then
 * `voided`; it was the bidding power once, but the newer hold that displaced it is the one in place.
 *
 * So a hold counts here only while it is `authorized`, or once it ended straight from `authorized`
 * (settlement captured or released it, PayPal voided it, or it expired). Every move to `replaced`
 * writes its row on the paddle's channel in the same transaction (hold-store.ts), which is how a
 * row that was refused is told apart from one that ended as the bidding power: both can carry no
 * replaced_by_hold_id.
 */
import type { Queryable } from "@/server/db/transaction";
import type { HoldStatus } from "@/server/paypal/hold-store";

/**
 * SQL that is true when hold `alias` is the paddle's bidding power now, or ended as it. Every paddle
 * that ever held bidding power has such a hold: a raise's chain of holds ends in one.
 */
export function isOrWasBiddingPowerSql(alias: string): string {
  return `(${alias}.status = 'authorized'
    or (${alias}.status in ('captured', 'voided', 'expired')
      and ${alias}.authorized_at is not null
      and ${alias}.replaced_by_hold_id is null
      and not exists (
        select 1 from event_log replaced_row
        where replaced_row.paddle_id = ${alias}.paddle_id and replaced_row.type = 'hold'
          and replaced_row.payload->>'holdId' = ${alias}.id::text and replaced_row.payload->>'status' = 'replaced')))`;
}

export interface BiddingHold {
  id: string;
  amountCents: number;
  status: HoldStatus;
  authorizedAt: Date | null;
  originalAuthorizationId: string | null;
  /** The paddle's settlement item for this hold has finished: captured, released, or settled in the database. */
  settled: boolean;
}

interface BiddingHoldRow {
  id: string;
  amount_cents: number;
  status: HoldStatus;
  authorized_at: Date | null;
  original_authorization_id: string | null;
  settled: boolean;
}

/**
 * The paddle's bidding power, or the hold that last was: once settlement has an item for the paddle,
 * that item's hold (what the charge captures or releases); before that, the authorized hold; and
 * with neither, the newest hold that ended as the bidding power. Null when the paddle never held any.
 */
export async function readBiddingHold(db: Queryable, paddleId: string): Promise<BiddingHold | null> {
  const { rows } = await db.query<BiddingHoldRow>(
    `with item as (
       select hold_id, status from settlement_items where paddle_id = $1 order by created_at desc limit 1
     )
     select h.id::text as id, h.amount_cents, h.status::text as status, h.authorized_at, h.original_authorization_id,
       coalesce((select item.status = 'succeeded' from item where item.hold_id = h.id), false) as settled
     from holds h
     where h.paddle_id = $1
       and (h.id = (select hold_id from item)
         or (not exists (select 1 from item) and ${isOrWasBiddingPowerSql("h")}))
     order by h.status = 'authorized' desc, h.authorized_at desc nulls last, h.created_at desc
     limit 1`,
    [paddleId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    amountCents: row.amount_cents,
    status: row.status,
    authorizedAt: row.authorized_at,
    originalAuthorizationId: row.original_authorization_id,
    settled: row.settled,
  };
}
