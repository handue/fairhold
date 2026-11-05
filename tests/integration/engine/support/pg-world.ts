import type pg from "pg";

import type { BidSource, EventStatus, LimitOwner, LotStatus } from "@/server/engine/types";

import {
  pick,
  sortLimits,
  type AuctionView,
  type World,
  type WorldConfig,
} from "../../../unit/engine/support/auction-model";

import { createEvent, createHold, createLot, createPaddle, expireLot, replaceHold } from "./fixtures";

/** The property-test World backed by Postgres: one fresh event per scenario. */
export async function createPgWorld(pool: pg.Pool, config: WorldConfig): Promise<World> {
  const eventId = await createEvent(pool);
  const paddleIds: string[] = [];
  for (const [index, hold] of config.holds.entries()) {
    const paddleId = await createPaddle(pool, eventId, 100 + index);
    if (hold !== null) await createHold(pool, eventId, paddleId, hold);
    paddleIds.push(paddleId);
  }
  const lotIds: string[] = [];
  for (const [index, lot] of config.lots.entries()) {
    lotIds.push(await createLot(pool, eventId, { number: index + 1, ...lot }));
  }
  return {
    eventId,
    lotIds,
    paddleIds,
    engine: { pool },
    view: () => pgView(pool, eventId, lotIds, paddleIds),
    expireLot: (lot) => expireLot(pool, pick(lotIds, lot)),
    raiseHold: (paddle, amountCents) => replaceHold(pool, eventId, pick(paddleIds, paddle), amountCents),
  };
}

export async function pgView(
  pool: pg.Pool,
  eventId: string,
  lotIds: readonly string[],
  paddleIds: readonly string[],
): Promise<AuctionView> {
  const paddleIndex = (id: string | null) => (id === null ? null : paddleIds.indexOf(id));
  const lotIndex = (id: string) => lotIds.indexOf(id);

  const event = await pool.query<{ status: EventStatus }>("select status from events where id = $1", [eventId]);
  const lots = await pool.query<{
    id: string;
    status: LotStatus;
    starting_bid_cents: number;
    min_raise_cents: number;
    current_bid_cents: number | null;
    bid_count: number;
    high_paddle_id: string | null;
    winning_paddle_id: string | null;
    winning_cents: number | null;
    past_close: boolean;
  }>(
    `select id, status, starting_bid_cents, min_raise_cents, current_bid_cents, bid_count, high_paddle_id,
       winning_paddle_id, winning_cents, now() >= closes_at as past_close
     from lots where id = any($1)`,
    [lotIds],
  );
  // Amount order is placement order within a lot: each accepted bid had to beat the last one.
  // created_at cannot order them: it is each transaction's start, and under concurrency a
  // transaction can start first and still take the lot lock last. A race that slipped a lower
  // bid in late would still show, as a current bid or winner that is not the highest bid.
  const bids = await pool.query<{
    lot_id: string;
    paddle_id: string;
    amount_cents: number;
    source: BidSource;
    limit_max_cents: number | null;
    before_close: boolean;
    before_lot_closed: boolean;
  }>(
    `select b.lot_id, b.paddle_id, b.amount_cents, b.source, bl.max_cents as limit_max_cents,
       b.created_at < l.closes_at as before_close,
       (l.closed_at is null or b.created_at < l.closed_at) as before_lot_closed
     from bids b
     join lots l on l.id = b.lot_id
     left join bid_limits bl on bl.id = b.limit_id
     where b.lot_id = any($1)
     order by b.amount_cents`,
    [lotIds],
  );
  const limits = await pool.query<{
    paddle_id: string;
    lot_id: string;
    max_cents: number;
    owner: LimitOwner;
    active: boolean;
    paused: boolean;
    exhausted: boolean;
  }>(
    `select paddle_id, lot_id, max_cents, owner, active, paused_at is not null as paused,
       exhausted_at is not null as exhausted
     from bid_limits where lot_id = any($1)`,
    [lotIds],
  );
  const holds = await pool.query<{ paddle_id: string; amount_cents: number }>(
    "select paddle_id, amount_cents from holds where paddle_id = any($1) and status = 'authorized'",
    [paddleIds],
  );

  const lotById = new Map(lots.rows.map((row) => [row.id, row]));
  return {
    eventStatus: event.rows[0]?.status ?? "draft",
    lots: lotIds.map((id) => {
      const row = lotById.get(id);
      if (!row) throw new Error(`no lot ${id}`);
      return {
        status: row.status,
        startingBidCents: row.starting_bid_cents,
        minRaiseCents: row.min_raise_cents,
        currentBidCents: row.current_bid_cents,
        bidCount: row.bid_count,
        highPaddle: paddleIndex(row.high_paddle_id),
        winningPaddle: paddleIndex(row.winning_paddle_id),
        winningCents: row.winning_cents,
        pastClose: row.past_close,
      };
    }),
    bids: bids.rows
      .map((row) => ({
        lot: lotIndex(row.lot_id),
        paddle: paddleIds.indexOf(row.paddle_id),
        amountCents: row.amount_cents,
        source: row.source,
        limitMaxCents: row.limit_max_cents,
        createdBeforeClose: row.before_close,
        createdBeforeLotClosed: row.before_lot_closed,
      }))
      .sort((a, b) => a.lot - b.lot),
    limits: sortLimits(
      limits.rows.map((row) => ({
        paddle: paddleIds.indexOf(row.paddle_id),
        lot: lotIndex(row.lot_id),
        maxCents: row.max_cents,
        owner: row.owner,
        active: row.active,
        paused: row.paused,
        exhausted: row.exhausted,
      })),
    ),
    holds: paddleIds.map((id) => holds.rows.find((row) => row.paddle_id === id)?.amount_cents ?? null),
  };
}
