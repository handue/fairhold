import { randomBytes } from "node:crypto";

import type pg from "pg";

type Queryable = Pick<pg.ClientBase, "query">;

async function insertReturningId(db: Queryable, text: string, values: unknown[]): Promise<string> {
  const { rows } = await db.query<{ id: string }>(text, values);
  const id = rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

export async function createEvent(db: Queryable, status = "live"): Promise<string> {
  return insertReturningId(
    db,
    `insert into events (slug, name, charity_name, closes_at, status)
     values ($1, 'Riverside Shelter Gala', 'Riverside Animal Shelter', now() + interval '2 hours', $2)
     returning id`,
    [`gala-${randomBytes(6).toString("hex")}`, status],
  );
}

export async function createPaddle(db: Queryable, eventId: string, number: number): Promise<string> {
  return insertReturningId(
    db,
    `insert into paddles (event_id, number, first_name, last_initial, is_simulated)
     values ($1, $2, $3, 'T', true)
     returning id`,
    [eventId, number, `Guest ${number}`],
  );
}

export async function createHold(
  db: Queryable,
  eventId: string,
  paddleId: string,
  amountCents: number,
  status = "authorized",
): Promise<string> {
  return insertReturningId(
    db,
    `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
     values ($1, $2, 'simulated', $3, $4, now())
     returning id`,
    [eventId, paddleId, amountCents, status],
  );
}

export interface LotFixture {
  number: number;
  startingBidCents: number;
  minRaiseCents: number;
  closesInSeconds?: number;
  status?: "draft" | "open" | "closed";
}

export async function createLot(db: Queryable, eventId: string, lot: LotFixture): Promise<string> {
  return insertReturningId(
    db,
    `insert into lots (event_id, number, short_title, title, category, starting_bid_cents, min_raise_cents,
       closes_at, status)
     values ($1, $2, $3, $3, 'dining', $4, $5, now() + make_interval(secs => $6), $7)
     returning id`,
    [
      eventId,
      lot.number,
      `Lot ${lot.number}`,
      lot.startingBidCents,
      lot.minRaiseCents,
      lot.closesInSeconds ?? 3_600,
      lot.status ?? "open",
    ],
  );
}

/** The demo's "Close next lot": closes_at becomes now, so every later transaction is past it. */
export async function expireLot(db: Queryable, lotId: string): Promise<void> {
  await db.query("update lots set closes_at = now() where id = $1 and closes_at > now()", [lotId]);
}

/** The raise flow's swap: the old hold is replaced and a larger one authorized, in one transaction. */
export async function replaceHold(pool: pg.Pool, eventId: string, paddleId: string, amountCents: number) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("update holds set status = 'replaced' where paddle_id = $1 and status = 'authorized'", [
      paddleId,
    ]);
    await createHold(client, eventId, paddleId, amountCents);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function lotRow(db: Queryable, lotId: string) {
  const { rows } = await db.query<{
    status: string;
    current_bid_cents: number | null;
    bid_count: number;
    high_paddle_id: string | null;
    winning_paddle_id: string | null;
    winning_cents: number | null;
    closes_at: Date;
    closed_at: Date | null;
  }>(
    `select status, current_bid_cents, bid_count, high_paddle_id, winning_paddle_id, winning_cents, closes_at, closed_at
     from lots where id = $1`,
    [lotId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no lot ${lotId}`);
  return row;
}
