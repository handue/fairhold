/**
 * Real demo galas for the director's tests, and a clock the test moves. Jobs decide by the clock they
 * are given, so a test can stand at +10:31 although the engine, on the database clock, is still in
 * the demo's first seconds and accepts every bid the director decides to place.
 */
import type pg from "pg";

import { createDemoEvent } from "@/server/demo/createDemoEvent";
import { DEMO_LIFETIME_MS } from "@/server/demo/demoPlan";
import { runDueJobs, type JobReport } from "@/server/director/run";
import { placeBid } from "@/server/engine";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { getPayments } from "@/server/paypal/runtime";
import { completeHoldApproval } from "@/server/paypal/holds";

export interface DemoGala {
  eventId: string;
  slug: string;
  /** The instant the demo opened. */
  start: Date;
  /** The creator's paddle 142, a real guest with no hold yet. */
  jamie: string;
  lots: ReadonlyMap<number, string>;
  paddles: ReadonlyMap<number, string>;
  lot(number: number): string;
  paddle(number: number): string;
  /** An instant of the demo, as +minutes:seconds. */
  at(minutes: number, seconds?: number): Date;
}

export async function startGala(pool: pg.Pool, firstName = "Jamie"): Promise<DemoGala> {
  const { event, creator } = await createDemoEvent({ creatorFirstName: firstName }, pool);
  const { rows: lots } = await pool.query<{ id: string; number: number }>("select id, number from lots where event_id = $1", [event.id]);
  const { rows: paddles } = await pool.query<{ id: string; number: number }>("select id, number from paddles where event_id = $1", [event.id]);
  const lotIds = new Map(lots.map((row) => [row.number, row.id]));
  const paddleIds = new Map(paddles.map((row) => [row.number, row.id]));
  const start = new Date((event.demoExpiresAt?.getTime() ?? 0) - DEMO_LIFETIME_MS);
  const lookup = (ids: ReadonlyMap<number, string>, number: number) => {
    const id = ids.get(number);
    if (!id) throw new Error(`no ${number}`);
    return id;
  };
  return {
    eventId: event.id,
    slug: event.slug,
    start,
    jamie: creator.paddleId,
    lots: lotIds,
    paddles: paddleIds,
    lot: (number) => lookup(lotIds, number),
    paddle: (number) => lookup(paddleIds, number),
    at: (minutes, seconds = 0) => new Date(start.getTime() + (minutes * 60 + seconds) * 1_000),
  };
}

/** A hold a real guest's bids count against, without any PayPal window. */
export async function giveHold(pool: pg.Pool, gala: DemoGala, paddleId: string, amountCents: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
     values ($1, $2, 'simulated', $3, 'authorized', now()) returning id`,
    [gala.eventId, paddleId, amountCents],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no hold");
  return id;
}

/** The whole PayPal window flow on the keyless simulation, as the return page runs it. */
export async function approveRealHold(pool: pg.Pool, eventId: string, paddleId: string, amountCents: number): Promise<{ holdId: string; authorizationId: string }> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', $3) returning id",
    [eventId, paddleId, amountCents],
  );
  const holdId = rows[0]?.id;
  if (!holdId) throw new Error("no hold");
  const order = await getPayments("paypal").createAuthorizeOrder({
    holdId,
    amountCents,
    description: "Bidding power",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `https://fairhold.example/paypal/return?hold=${holdId}`,
    cancelUrl: `https://fairhold.example/paypal/cancel?hold=${holdId}`,
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  await pool.query("update holds set paypal_order_id = $2 where id = $1", [holdId, order.orderId]);
  const outcome = await completeHoldApproval({ holdId, orderId: order.orderId });
  if (outcome.kind !== "authorized") throw new Error(`approval ended as ${outcome.kind}`);
  const authorizationId = outcome.hold.originalAuthorizationId;
  if (!authorizationId) throw new Error("no authorization");
  return { holdId, authorizationId };
}

export async function bidByHand(pool: pg.Pool, paddleId: string, lotId: string, cents: number): Promise<void> {
  const placed = await placeBid(paddleId, lotId, cents, "guest", { pool });
  if (!placed.ok) throw new Error(`bid refused: ${placed.refusal.reason}`);
}

/** Moves the test's clock forward, a minute at a time as the tick would, running what comes due. */
export async function walk(pool: pg.Pool, from: Date, to: Date): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  for (let at = from.getTime(); at < to.getTime(); at += 60_000) reports.push(...(await runDueJobs({ pool, now: new Date(at) })));
  reports.push(...(await runDueJobs({ pool, now: to })));
  return reports;
}

export interface LotRow {
  current_bid_cents: number | null;
  high_paddle_id: string | null;
  high_bid_source: string | null;
  bid_count: number;
  status: string;
  closes_at: Date;
}

export async function lotRow(pool: pg.Pool, lotId: string): Promise<LotRow> {
  const { rows } = await pool.query<LotRow>(
    "select current_bid_cents, high_paddle_id, high_bid_source, bid_count, status, closes_at from lots where id = $1",
    [lotId],
  );
  const row = rows[0];
  if (!row) throw new Error(`no lot ${lotId}`);
  return row;
}

export interface JobRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  run_at: Date;
  payload: { result?: { outcome: string; reason?: string; amountCents?: number; paddleNumber?: number }; [key: string]: unknown };
  last_error: string | null;
  completed_at: Date | null;
}

export async function jobsOf(pool: pg.Pool, eventId: string, kind?: string): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(
    `select id, kind, status, attempts, run_at, payload, last_error, completed_at from director_jobs
     where event_id = $1 and ($2::text is null or kind = $2) order by run_at, id`,
    [eventId, kind ?? null],
  );
  return rows;
}

export async function rows<T extends Record<string, unknown>>(pool: pg.Pool, text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(text, values)).rows;
}
