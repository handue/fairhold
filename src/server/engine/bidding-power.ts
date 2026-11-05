import type pg from "pg";

import { getPool } from "@/server/db/client";

import type { Cents, LimitOwner } from "./types";

/**
 * Per-lot commitments of the paddles in $1 (an array of paddle ids): the SQL twin of
 * commitmentCents in rules.ts, and the one definition every reader of "bidding power" shares
 * (the engine's invariant, the nav pill, My paddle, Glim's allocator, the control room check).
 */
export const COMMITMENTS_SQL = `
  select pd.id as paddle_id, l.id as lot_id,
    case
      when l.status = 'closed'
        then case when l.winning_paddle_id = pd.id then coalesce(l.winning_cents, 0) else 0 end
      else greatest(
        coalesce(bl.max_cents, 0),
        case when l.high_paddle_id = pd.id then coalesce(l.current_bid_cents, 0) else 0 end
      )
    end as commitment_cents,
    case when l.status <> 'closed' and l.high_paddle_id = pd.id
      then coalesce(l.current_bid_cents, 0) else 0 end as leading_cents,
    case when l.status = 'closed' and l.winning_paddle_id = pd.id
      then coalesce(l.winning_cents, 0) else 0 end as won_cents,
    bl.owner as limit_owner,
    bl.max_cents as limit_cents
  from paddles pd
  join lots l on l.event_id = pd.event_id
  left join bid_limits bl on bl.lot_id = l.id and bl.paddle_id = pd.id and bl.active
  where pd.id = any($1)
    and (bl.id is not null or l.high_paddle_id = pd.id or l.winning_paddle_id = pd.id)`;

export interface LotCommitment {
  paddleId: string;
  lotId: string;
  /** What the invariant counts on this lot. */
  cents: Cents;
  /** The paddle's leading bid on an open lot, else 0. */
  leadingCents: Cents;
  /** What the paddle won on a closed lot, else 0. */
  wonCents: Cents;
  /** The paddle's active limit on the lot (a guest max or Glim's), if it has one. */
  limitOwner: LimitOwner | null;
  limitCents: Cents | null;
}

export interface BiddingPower {
  paddleId: string;
  holdId: string | null;
  /** The authorized hold; 0 without one. */
  holdCents: Cents;
  /** Leading bids, active limits at their max and won lots: what the invariant keeps within the hold. */
  committedCents: Cents;
  /** What a new bid or limit can still commit: holdCents minus committedCents. */
  availableCents: Cents;
  leadingCents: Cents;
  wonCents: Cents;
  /** Held back by limits above their leading bids (on My paddle: Glim's room). */
  reservedCents: Cents;
  /** The figure guests see as left: holdCents minus leading bids and won lots. */
  leftCents: Cents;
}

type Queryable = Pick<pg.ClientBase, "query">;

interface CommitmentRowRecord {
  paddle_id: string;
  lot_id: string;
  commitment_cents: number;
  leading_cents: number;
  won_cents: number;
  limit_owner: LimitOwner | null;
  limit_cents: number | null;
}

export async function getCommitments(
  paddleIds: readonly string[],
  db: Queryable = getPool(),
): Promise<LotCommitment[]> {
  if (paddleIds.length === 0) return [];
  const { rows } = await db.query<CommitmentRowRecord>(COMMITMENTS_SQL, [paddleIds]);
  return rows.map((row) => ({
    paddleId: row.paddle_id,
    lotId: row.lot_id,
    cents: row.commitment_cents,
    leadingCents: row.leading_cents,
    wonCents: row.won_cents,
    limitOwner: row.limit_owner,
    limitCents: row.limit_cents,
  }));
}

interface BiddingPowerRecord {
  paddle_id: string;
  hold_id: string | null;
  hold_cents: number;
  committed_cents: number;
  leading_cents: number;
  won_cents: number;
}

/** Bidding power per paddle; paddles that do not exist are missing from the map. */
export async function getBiddingPower(
  paddleIds: readonly string[],
  db: Queryable = getPool(),
): Promise<Map<string, BiddingPower>> {
  if (paddleIds.length === 0) return new Map();
  const { rows } = await db.query<BiddingPowerRecord>(
    `with commitments as (${COMMITMENTS_SQL})
     select pd.id as paddle_id, h.id as hold_id, coalesce(h.amount_cents, 0) as hold_cents,
       coalesce(sum(c.commitment_cents), 0)::int as committed_cents,
       coalesce(sum(c.leading_cents), 0)::int as leading_cents,
       coalesce(sum(c.won_cents), 0)::int as won_cents
     from paddles pd
     left join holds h on h.paddle_id = pd.id and h.status = 'authorized'
     left join commitments c on c.paddle_id = pd.id
     where pd.id = any($1)
     group by pd.id, h.id, h.amount_cents`,
    [paddleIds],
  );
  return new Map(
    rows.map((row) => [
      row.paddle_id,
      {
        paddleId: row.paddle_id,
        holdId: row.hold_id,
        holdCents: row.hold_cents,
        committedCents: row.committed_cents,
        availableCents: Math.max(0, row.hold_cents - row.committed_cents),
        leadingCents: row.leading_cents,
        wonCents: row.won_cents,
        reservedCents: row.committed_cents - row.leading_cents - row.won_cents,
        leftCents: Math.max(0, row.hold_cents - row.leading_cents - row.won_cents),
      },
    ]),
  );
}
