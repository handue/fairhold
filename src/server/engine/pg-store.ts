import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { appendEventLog } from "@/server/sse/notify";

import { COMMITMENTS_SQL } from "./bidding-power";
import { toEventLogEntry } from "./events";
import type { ChangeSet, EngineStore, EngineTx, LotBidder, LotRef, NewBid, NewLimit } from "./store";
import type {
  BidSource,
  CommitmentRow,
  EventStatus,
  HoldState,
  LimitOwner,
  LimitState,
  LotState,
  LotStatus,
  PaddleInfo,
} from "./types";

/*
 * The Postgres store. Every engine transaction runs at READ COMMITTED with explicit row locks
 * (see the lock order in store.ts). Whether a lot is still open is read from the database clock
 * once its lock is held (see lockLots), so app-server clock skew never decides it.
 */

/** How every engine transaction starts; Glim's plan transactions (src/server/plans) start the same way. */
export const ENGINE_TRANSACTION_BEGIN = "begin; set local lock_timeout = '5s'; set local statement_timeout = '15s'";
/** Deadlocks and serialization failures are retried; with the fixed lock order they should not occur. */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01"]);
const MAX_ATTEMPTS = 3;
/** Six parameters per bid keeps one insert well under Postgres's 65,535-parameter limit. */
const BIDS_PER_INSERT = 1_000;

export function createPgStore(pool: pg.Pool): EngineStore {
  return {
    async transaction<T>(work: (tx: EngineTx) => Promise<T>): Promise<T> {
      for (let attempt = 1; ; attempt += 1) {
        const client = await pool.connect();
        let connectionBroken = false;
        try {
          await client.query(ENGINE_TRANSACTION_BEGIN);
          const result = await work(new PgEngineTx(client));
          await client.query("commit");
          return result;
        } catch (error) {
          connectionBroken = !(await rollbackQuietly(client));
          if (attempt < MAX_ATTEMPTS && RETRYABLE_SQLSTATES.has(sqlState(error))) {
            await sleep(10 * attempt + Math.floor(Math.random() * 10));
            continue;
          }
          throw error;
        } finally {
          client.release(connectionBroken);
        }
      }
    },
  };
}

/**
 * An engine store over a transaction its caller already began on `client`: the engine's actions
 * run inside it and write nothing on a refusal, and the caller owns begin, commit, rollback and
 * any retry. This is how src/server/plans/apply.ts makes a plan change and its records commit
 * together or not at all.
 */
export function createTransactionStore(client: pg.ClientBase): EngineStore {
  return {
    async transaction<T>(work: (tx: EngineTx) => Promise<T>): Promise<T> {
      return work(new PgEngineTx(client));
    },
  };
}

async function rollbackQuietly(client: pg.PoolClient): Promise<boolean> {
  try {
    await client.query("rollback");
    return true;
  } catch {
    return false;
  }
}

function sqlState(error: unknown): string {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "";
}

type LotRecord = {
  id: string;
  event_id: string;
  number: number;
  status: LotStatus;
  event_status: EventStatus;
  starting_bid_cents: number;
  min_raise_cents: number;
  current_bid_cents: number | null;
  bid_count: number;
  high_paddle_id: string | null;
  high_bid_source: BidSource | null;
  closes_at: Date;
  winning_paddle_id: string | null;
  winning_cents: number | null;
  closed_at: Date | null;
};

type LimitRecord = {
  id: string;
  paddle_id: string;
  lot_id: string;
  max_cents: number;
  owner: LimitOwner;
  plan_item_id: string | null;
  paused: boolean;
  created_at: Date;
};

class PgEngineTx implements EngineTx {
  constructor(private readonly client: pg.ClientBase) {}

  newId(): string {
    return randomUUID();
  }

  async findPaddles(paddleIds: readonly string[]): Promise<PaddleInfo[]> {
    if (paddleIds.length === 0) return [];
    const { rows } = await this.client.query<{ id: string; event_id: string; number: number }>(
      "select id, event_id, number from paddles where id = any($1)",
      [paddleIds],
    );
    return rows.map((row) => ({ id: row.id, eventId: row.event_id, number: row.number }));
  }

  async lockLots(lotIds: readonly string[]): Promise<LotState[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.client.query<LotRecord>(
      `select l.id, l.event_id, l.number, l.status, e.status as event_status,
         l.starting_bid_cents, l.min_raise_cents, l.current_bid_cents, l.bid_count,
         l.high_paddle_id, l.high_bid_source, l.closes_at,
         l.winning_paddle_id, l.winning_cents, l.closed_at
       from lots l
       join events e on e.id = l.event_id
       where l.id = any($1)
       order by l.id
       for update of l`,
      [lotIds],
    );
    // A second statement, so the clock is read after every lock is granted. The locking statement
    // computes its columns before it waits, and neither now() nor that value would refuse a bid
    // that queued behind the lot until after closes_at.
    const { rows: clock } = await this.client.query<{ id: string; past_close: boolean }>(
      "select id, clock_timestamp() >= closes_at as past_close from lots where id = any($1)",
      [lotIds],
    );
    const pastClose = new Map(clock.map((row) => [row.id, row.past_close]));
    return rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      number: row.number,
      status: row.status,
      eventStatus: row.event_status,
      startingBidCents: row.starting_bid_cents,
      minRaiseCents: row.min_raise_cents,
      currentBidCents: row.current_bid_cents,
      bidCount: row.bid_count,
      highPaddleId: row.high_paddle_id,
      highBidSource: row.high_bid_source,
      closesAt: row.closes_at,
      pastClose: pastClose.get(row.id) ?? true,
      winningPaddleId: row.winning_paddle_id,
      winningCents: row.winning_cents,
      closedAt: row.closed_at,
    }));
  }

  async activeLimitsOnLots(lotIds: readonly string[]): Promise<LimitState[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.client.query<LimitRecord>(
      `select id, paddle_id, lot_id, max_cents, owner, plan_item_id, paused_at is not null as paused, created_at
       from bid_limits
       where lot_id = any($1) and active
       order by created_at, id`,
      [lotIds],
    );
    return rows.map((row) => ({
      id: row.id,
      paddleId: row.paddle_id,
      lotId: row.lot_id,
      maxCents: row.max_cents,
      owner: row.owner,
      planItemId: row.plan_item_id,
      paused: row.paused,
      createdAt: row.created_at,
    }));
  }

  async activeLimitLotIds(paddleId: string, owner: LimitOwner | null): Promise<string[]> {
    const { rows } =
      owner === null
        ? await this.client.query<{ lot_id: string }>(
            "select lot_id from bid_limits where paddle_id = $1 and active order by lot_id",
            [paddleId],
          )
        : await this.client.query<{ lot_id: string }>(
            "select lot_id from bid_limits where paddle_id = $1 and active and owner = $2 order by lot_id",
            [paddleId, owner],
          );
    return rows.map((row) => row.lot_id);
  }

  async lockAuthorizedHolds(paddleIds: readonly string[]): Promise<HoldState[]> {
    if (paddleIds.length === 0) return [];
    // NO KEY UPDATE rather than UPDATE: inserting a bid or a limit takes its foreign-key lock on
    // the paddle row without waiting for this transaction.
    await this.client.query("select id from paddles where id = any($1) order by id for no key update", [paddleIds]);

    const holds = await this.lockHoldsOf(paddleIds);
    const withoutHold = () => paddleIds.filter((paddleId) => !holds.some((hold) => hold.paddleId === paddleId));
    for (let missing = withoutHold(); missing.length > 0; missing = withoutHold()) {
      const found = await this.lockHoldsOf(missing);
      if (found.length === 0) break;
      holds.push(...found);
    }
    return holds.sort((a, b) => (a.paddleId < b.paddleId ? -1 : a.paddleId > b.paddleId ? 1 : 0));
  }

  private async lockHoldsOf(paddleIds: readonly string[]): Promise<HoldState[]> {
    const { rows } = await this.client.query<{ id: string; paddle_id: string; amount_cents: number }>(
      `select id, paddle_id, amount_cents
       from holds
       where paddle_id = any($1) and status = 'authorized'
       order by paddle_id
       for update`,
      [paddleIds],
    );
    return rows.map((row) => ({ id: row.id, paddleId: row.paddle_id, amountCents: row.amount_cents }));
  }

  async commitments(paddleIds: readonly string[]): Promise<CommitmentRow[]> {
    if (paddleIds.length === 0) return [];
    const { rows } = await this.client.query<{ paddle_id: string; lot_id: string; commitment_cents: number }>(
      COMMITMENTS_SQL,
      [paddleIds],
    );
    return rows.map((row) => ({ paddleId: row.paddle_id, lotId: row.lot_id, cents: row.commitment_cents }));
  }

  async lotBidders(lotIds: readonly string[]): Promise<LotBidder[]> {
    if (lotIds.length === 0) return [];
    const { rows } = await this.client.query<{ lot_id: string; paddle_id: string }>(
      "select distinct lot_id, paddle_id from bids where lot_id = any($1)",
      [lotIds],
    );
    return rows.map((row) => ({ lotId: row.lot_id, paddleId: row.paddle_id }));
  }

  async dueLots(asOf: Date | null, limit: number): Promise<LotRef[]> {
    const { rows } = await this.client.query<{ id: string; event_id: string }>(
      `select id, event_id
       from lots
       where status = 'open' and closes_at <= least(now(), coalesce($1::timestamptz, now()))
       order by closes_at, id
       limit $2`,
      [asOf, limit],
    );
    return rows.map((row) => ({ id: row.id, eventId: row.event_id }));
  }

  async liveEventsWithoutOpenLots(limit: number): Promise<string[]> {
    const { rows } = await this.client.query<{ id: string }>(
      `select e.id
       from events e
       where e.status = 'live'
         and exists (select 1 from lots l where l.event_id = e.id)
         and not exists (select 1 from lots l where l.event_id = e.id and l.status = 'open')
       order by e.id
       limit $1`,
      [limit],
    );
    return rows.map((row) => row.id);
  }

  async openLotIds(eventId: string): Promise<string[]> {
    const { rows } = await this.client.query<{ id: string }>(
      "select id from lots where event_id = $1 and status = 'open' order by id",
      [eventId],
    );
    return rows.map((row) => row.id);
  }

  async closeEventIfDone(eventId: string): Promise<boolean> {
    const { rowCount } = await this.client.query(
      `update events e
       set status = 'closed', closed_at = clock_timestamp()
       where e.id = $1 and e.status = 'live'
         and not exists (select 1 from lots l where l.event_id = e.id and l.status = 'open')`,
      [eventId],
    );
    return rowCount === 1;
  }

  async apply(changes: ChangeSet): Promise<void> {
    // Old limits end before new ones are inserted: one active limit per paddle and lot.
    if (changes.endedLimits.length > 0) {
      await this.client.query(
        `update bid_limits
         set active = false, ended_at = now(),
           exhausted_at = case when id = any($2) then now() else exhausted_at end
         where id = any($1)`,
        [
          changes.endedLimits.map((limit) => limit.id),
          changes.endedLimits.filter((limit) => limit.exhausted).map((limit) => limit.id),
        ],
      );
    }
    if (changes.newLimits.length > 0) await this.insertLimits(changes.newLimits);
    if (changes.pausedLimitIds.length > 0) {
      await this.client.query("update bid_limits set paused_at = now() where id = any($1)", [
        changes.pausedLimitIds,
      ]);
    }
    if (changes.resumedLimitIds.length > 0) {
      await this.client.query("update bid_limits set paused_at = null where id = any($1)", [
        changes.resumedLimitIds,
      ]);
    }
    for (let start = 0; start < changes.bids.length; start += BIDS_PER_INSERT) {
      await this.insertBids(changes.bids.slice(start, start + BIDS_PER_INSERT));
    }
    for (const update of changes.lotUpdates) {
      await this.client.query(
        `update lots
         set current_bid_cents = $2, bid_count = $3, high_paddle_id = $4, high_bid_source = $5
         where id = $1`,
        [update.lotId, update.currentBidCents, update.bidCount, update.highPaddleId, update.highBidSource],
      );
    }
    for (const close of changes.lotCloses) {
      // clock_timestamp(), not now(): this transaction may have started before a bid that held
      // the lot lock ahead of it. The lock was granted after that bid committed, so the moment
      // read here falls after every accepted bid's created_at.
      await this.client.query(
        `update lots
         set status = 'closed', winning_paddle_id = $2, winning_cents = $3, closed_at = clock_timestamp(),
           closes_at = case when $4 then least(closes_at, clock_timestamp()) else closes_at end
         where id = $1`,
        [close.lotId, close.winningPaddleId, close.winningCents, close.forced],
      );
    }
    if (changes.events.length > 0) {
      await appendEventLog(this.client, changes.events.map(toEventLogEntry));
    }
  }

  private async insertLimits(limits: readonly NewLimit[]): Promise<void> {
    const values: unknown[] = [];
    const tuples = limits.map((limit) => {
      values.push(
        limit.id,
        limit.paddleId,
        limit.lotId,
        limit.maxCents,
        limit.owner,
        limit.planItemId,
        limit.active,
        limit.exhausted,
      );
      const n = values.length;
      const active = `$${n - 1}`;
      const exhausted = `$${n}`;
      return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, ${active},
        case when ${active} then null else now() end, case when ${exhausted} then now() end)`;
    });
    await this.client.query(
      `insert into bid_limits
         (id, paddle_id, lot_id, max_cents, owner, plan_item_id, active, ended_at, exhausted_at)
       values ${tuples.join(", ")}`,
      values,
    );
  }

  private async insertBids(bids: readonly NewBid[]): Promise<void> {
    const values: unknown[] = [];
    const tuples = bids.map((bid) => {
      values.push(bid.id, bid.lotId, bid.paddleId, bid.amountCents, bid.source, bid.limitId);
      const n = values.length;
      return `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    await this.client.query(
      `insert into bids (id, lot_id, paddle_id, amount_cents, source, limit_id) values ${tuples.join(", ")}`,
      values,
    );
  }
}
