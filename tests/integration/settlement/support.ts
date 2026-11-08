/**
 * What the settlement tests share: a gala that really ran through the engine, and PayPal at the wire.
 *
 * `paypalWorld` answers the sandbox client's HTTP requests with PayPal's documented rules, on top of
 * tests/unit/paypal/fake-paypal.ts: a repeated PayPal-Request-Id replays the stored answer, a capture
 * is final, an invoice id works once, and a capture may not exceed its authorization. Tests script a
 * failure with `failNext`, and read what PayPal saw from `captures`, `voids` and `reauthorizations`.
 */
import { randomBytes } from "node:crypto";

import type pg from "pg";

import { closeEvent, placeBid } from "@/server/engine";
import { centsToPaypalValue } from "@/server/paypal/money";
import type { PaypalHttpRequest, PaypalHttpResponse } from "@/server/paypal/sandbox-client";
import { PaypalSandboxClient } from "@/server/paypal/sandbox-client";
import { SandboxPayments } from "@/server/paypal/sandbox-payments";
import type { HoldKind, Payments } from "@/server/paypal/payments";
import type { SettlementDependencies } from "@/server/settlement/dependencies";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import type { Database } from "@/server/db/client";

import { authorizationBody, bodyOf, empty, FakePaypal, json, paypalError } from "../../unit/paypal/fake-paypal";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";

export interface WorldAuthorization {
  id: string;
  amountCents: number;
  status: string;
  /** The reauthorization's parent, as PayPal keeps it. */
  parentId: string | null;
}

export interface WorldCapture {
  authorizationId: string;
  requestId: string;
  amountCents: number;
  invoiceId: string;
  finalCapture: boolean;
  softDescriptor: string | undefined;
  noteToPayer: string | undefined;
  captureId: string;
}

type Responder = (request: PaypalHttpRequest) => PaypalHttpResponse;

let worlds = 0;

export function paypalWorld() {
  worlds += 1;
  const worldId = worlds;
  const paypal = new FakePaypal();
  const payments = new SandboxPayments(
    new PaypalSandboxClient({ clientId: "test-client", clientSecret: "test-secret", http: paypal.http }),
  );
  const authorizations = new Map<string, WorldAuthorization>();
  const captures: WorldCapture[] = [];
  const voids: { authorizationId: string; requestId: string }[] = [];
  const reauthorizations: { authorizationId: string; requestId: string; amountCents: number; newId: string }[] = [];
  const invoices = new Set<string>();
  const replies = new Map<string, PaypalHttpResponse>();
  const scripted = new Map<string, Responder[]>();

  /** The answer to a POST: a scripted failure, then a replay, then the real thing. */
  const post = (key: string, request: PaypalHttpRequest, run: () => PaypalHttpResponse): PaypalHttpResponse => {
    const next = scripted.get(key)?.shift();
    if (next) return next(request);
    const requestId = request.headers["paypal-request-id"] ?? "";
    const replayKey = `${key}:${requestId}`;
    const stored = replies.get(replayKey);
    if (stored) return stored;
    const reply = run();
    if (reply.status < 500) replies.set(replayKey, reply);
    return reply;
  };

  const capture = (id: string, request: PaypalHttpRequest): PaypalHttpResponse => {
    const authorization = authorizations.get(id);
    if (!authorization) return paypalError(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "debug-404");
    const body = bodyOf(request) as {
      amount: { value: string };
      invoice_id: string;
      final_capture: boolean;
      soft_descriptor?: string;
      note_to_payer?: string;
    };
    if (authorization.status === "VOIDED") return paypalError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED", "debug-void");
    if (authorization.status !== "CREATED") {
      return paypalError(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED", "debug-captured");
    }
    const amountCents = Math.round(Number(body.amount.value) * 100);
    if (amountCents > authorization.amountCents) {
      return paypalError(422, "UNPROCESSABLE_ENTITY", "MAX_CAPTURE_AMOUNT_EXCEEDED", "debug-over");
    }
    if (invoices.has(body.invoice_id)) return paypalError(422, "UNPROCESSABLE_ENTITY", "DUPLICATE_INVOICE_ID", "debug-dup");
    invoices.add(body.invoice_id);
    authorization.status = "CAPTURED";
    // PayPal's ids are unique, so a webhook can never match another test's capture by accident.
    const captureId = `CAP${worldId}X${captures.length + 1}`;
    captures.push({
      authorizationId: id,
      requestId: request.headers["paypal-request-id"] ?? "",
      amountCents,
      invoiceId: body.invoice_id,
      finalCapture: body.final_capture,
      softDescriptor: body.soft_descriptor,
      noteToPayer: body.note_to_payer,
      captureId,
    });
    return json(201, {
      id: captureId,
      status: "COMPLETED",
      amount: { currency_code: "USD", value: body.amount.value },
      final_capture: body.final_capture,
      invoice_id: body.invoice_id,
      create_time: "2026-11-08T05:31:00Z",
    });
  };

  const authorize = (id: string, amountCents: number, parentId: string | null = null): WorldAuthorization => {
    const authorization: WorldAuthorization = { id, amountCents, status: "CREATED", parentId };
    authorizations.set(id, authorization);
    const base = `/v2/payments/authorizations/${id}`;
    paypal
      .on("GET", base, () =>
        json(200, authorizationBody(id, authorization.status, centsToPaypalValue(authorization.amountCents))),
      )
      .on("POST", `${base}/capture`, (request) => post(`capture:${id}`, request, () => capture(id, request)))
      .on("POST", `${base}/void`, (request) =>
        post(`void:${id}`, request, () => {
          if (authorization.parentId) return paypalError(422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_VOIDED", "debug-child");
          if (authorization.status === "VOIDED") return paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", "debug-voided");
          if (authorization.status === "CAPTURED") return paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED", "debug-cap");
          authorization.status = "VOIDED";
          voids.push({ authorizationId: id, requestId: request.headers["paypal-request-id"] ?? "" });
          return empty(204);
        }),
      )
      .on("POST", `${base}/reauthorize`, (request) =>
        post(`reauthorize:${id}`, request, () => {
          if (authorization.parentId) {
            return paypalError(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_NOT_SUPPORTED", "debug-reauth");
          }
          const { amount } = bodyOf(request) as { amount: { value: string } };
          const amountRenewed = Math.round(Number(amount.value) * 100);
          const newId = `${id}R${reauthorizations.length + 1}`;
          authorize(newId, amountRenewed, id);
          reauthorizations.push({
            authorizationId: id,
            requestId: request.headers["paypal-request-id"] ?? "",
            amountCents: amountRenewed,
            newId,
          });
          return json(201, authorizationBody(newId, "CREATED", amount.value, { create_time: new Date().toISOString() }));
        }),
      );
    return authorization;
  };

  return {
    paypal,
    payments,
    authorizations,
    captures,
    voids,
    reauthorizations,
    authorize,
    /** The next POST of this kind to this authorization answers this, instead of what PayPal would. */
    failNext(kind: "capture" | "void" | "reauthorize", authorizationId: string, responder: Responder) {
      const key = `${kind}:${authorizationId}`;
      scripted.set(key, [...(scripted.get(key) ?? []), responder]);
    },
    /** Every POST of this kind to this authorization, the failed and the replayed included. */
    posts(kind: "capture" | "void" | "reauthorize", authorizationId: string): PaypalHttpRequest[] {
      const path = `/v2/payments/authorizations/${authorizationId}/${kind}`;
      return paypal.requests.filter((request) => new URL(request.url).pathname === path);
    },
  };
}

export type PaypalWorld = ReturnType<typeof paypalWorld>;

/** PayPal only for real holds: a simulated guest's hold reaching it is a failure of its own. */
export function realOnly(payments: Payments): (kind: HoldKind) => Payments {
  return (kind) => {
    if (kind === "simulated") throw new Error("A simulated hold reached the payments interface");
    return payments;
  };
}

export function dependenciesFor(
  pool: pg.Pool,
  db: Database,
  payments: Payments,
  overrides: Partial<SettlementDependencies> = {},
): SettlementDependencies {
  return {
    pool,
    paymentsFor: realOnly(payments),
    now: () => new Date(),
    holdStore: createPostgresHoldStore(db),
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface RealHoldOptions {
  authorizationId?: string;
  amountCents: number;
  /** Days since PayPal authorized it: past 3, the honor period is over. */
  ageDays?: number;
  status?: "authorized" | "replaced";
}

/** A hold PayPal authorized: what the return page leaves behind. */
export async function insertRealHold(
  pool: pg.Pool,
  eventId: string,
  paddleId: string,
  { authorizationId, amountCents, ageDays = 0, status = "authorized" }: RealHoldOptions,
): Promise<{ holdId: string; authorizationId: string }> {
  const id = authorizationId ?? `AUTH${randomBytes(6).toString("hex").toUpperCase()}`;
  const authorizedAt = new Date(Date.now() - ageDays * DAY_MS);
  const { rows } = await pool.query<{ id: string }>(
    `insert into holds (event_id, paddle_id, kind, amount_cents, status, paypal_order_id, original_authorization_id,
       current_authorization_id, authorized_at, honor_until, expires_at)
     values ($1, $2, 'paypal', $3, $9, $4, $5, $5, $6, $7, $8)
     returning id`,
    [
      eventId,
      paddleId,
      amountCents,
      `ORDER${id}`,
      id,
      authorizedAt,
      new Date(authorizedAt.getTime() + 3 * DAY_MS),
      new Date(authorizedAt.getTime() + 29 * DAY_MS),
      status,
    ],
  );
  const holdId = rows[0]?.id;
  if (!holdId) throw new Error("insert returned no hold id");
  return { holdId, authorizationId: id };
}

export interface GalaSpec {
  /** Paddles with a real hold, by number. */
  real?: readonly { number: number; holdCents: number; ageDays?: number }[];
  /** Paddles with a simulated hold, by number. */
  simulated?: readonly { number: number; holdCents: number }[];
  /** Who wins each lot and for how much. The bids go through the engine. */
  wins?: readonly { number: number; lot: number; cents: number }[];
  /** Leave bidding open. */
  live?: boolean;
  /** The event's flag; a demo's holds never get reauthorized. */
  isDemo?: boolean;
}

export interface Gala {
  eventId: string;
  slug: string;
  paddles: Map<number, string>;
  lots: Map<number, string>;
  holds: Map<number, { holdId: string; authorizationId: string | null }>;
}

/** A gala run through the engine and, unless `live`, closed with its winners fixed. */
export async function runGala(pool: pg.Pool, world: PaypalWorld | null, spec: GalaSpec): Promise<Gala> {
  const eventId = await createEvent(pool);
  if (spec.isDemo) await pool.query("update events set is_demo = true where id = $1", [eventId]);
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
  const gala: Gala = { eventId, slug: rows[0]?.slug ?? "", paddles: new Map(), lots: new Map(), holds: new Map() };

  for (const { number, holdCents, ageDays } of spec.real ?? []) {
    const paddleId = await createPaddle(pool, eventId, number);
    await pool.query("update paddles set is_simulated = false where id = $1", [paddleId]);
    const hold = await insertRealHold(pool, eventId, paddleId, { amountCents: holdCents, ageDays });
    world?.authorize(hold.authorizationId, holdCents);
    gala.paddles.set(number, paddleId);
    gala.holds.set(number, hold);
  }
  for (const { number, holdCents } of spec.simulated ?? []) {
    const paddleId = await createPaddle(pool, eventId, number);
    gala.paddles.set(number, paddleId);
    gala.holds.set(number, { holdId: await createHold(pool, eventId, paddleId, holdCents), authorizationId: null });
  }
  for (const { number, lot, cents } of spec.wins ?? []) {
    const lotId = await createLot(pool, eventId, { number: lot, startingBidCents: cents, minRaiseCents: 100 });
    gala.lots.set(lot, lotId);
    const paddleId = gala.paddles.get(number);
    if (!paddleId) throw new Error(`No paddle ${number}`);
    const placed = await placeBid(paddleId, lotId, cents, "guest", { pool });
    if (!placed.ok) throw new Error(`Bid refused: ${placed.refusal.reason}`);
  }
  if (!spec.live) await closeEvent(eventId, { pool });
  return gala;
}

export interface ItemRow {
  id: string;
  paddle_number: number;
  hold_id: string;
  action: string;
  status: string;
  amount_cents: number;
  released_cents: number;
  attempts: number;
  paypal_request_id: string | null;
  paypal_capture_id: string | null;
  error_code: string | null;
  next_attempt_at: Date | null;
}

export async function itemsOf(pool: pg.Pool, eventId: string): Promise<ItemRow[]> {
  const { rows } = await pool.query<ItemRow>(
    `select i.id, p.number as paddle_number, i.hold_id, i.action, i.status, i.amount_cents, i.released_cents, i.attempts,
       i.paypal_request_id, i.paypal_capture_id, i.error_code, i.next_attempt_at
     from settlement_items i
     join settlements s on s.id = i.settlement_id
     join paddles p on p.id = i.paddle_id
     where s.event_id = $1
     order by p.number`,
    [eventId],
  );
  return rows;
}

export async function itemOf(pool: pg.Pool, eventId: string, paddleNumber: number): Promise<ItemRow> {
  const item = (await itemsOf(pool, eventId)).find((row) => row.paddle_number === paddleNumber);
  if (!item) throw new Error(`Paddle ${paddleNumber} has no settlement item`);
  return item;
}

export async function holdRow(pool: pg.Pool, holdId: string) {
  const { rows } = await pool.query<{
    status: string;
    amount_cents: number;
    captured_cents: number | null;
    original_authorization_id: string | null;
    current_authorization_id: string | null;
    reauthorized_at: Date | null;
    honor_until: Date | null;
  }>(
    `select status, amount_cents, captured_cents, original_authorization_id, current_authorization_id, reauthorized_at, honor_until
     from holds where id = $1`,
    [holdId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No hold ${holdId}`);
  return row;
}

export async function eventRow(pool: pg.Pool, eventId: string) {
  const { rows } = await pool.query<{ status: string; settled_at: Date | null; settlement_status: string | null }>(
    `select e.status, e.settled_at, s.status as settlement_status
     from events e left join settlements s on s.event_id = e.id
     where e.id = $1`,
    [eventId],
  );
  const row = rows[0];
  if (!row) throw new Error(`No event ${eventId}`);
  return row;
}

export async function receiptOf(pool: pg.Pool, eventId: string, paddleId: string) {
  const { rows } = await pool.query<{
    number: string;
    hold_cents: number;
    paid_cents: number;
    released_cents: number;
    deductible_cents: number;
    paypal_capture_id: string | null;
    statement_descriptor: string | null;
    lines: unknown[];
    glim_recap: unknown;
  }>(
    `select number, hold_cents, paid_cents, released_cents, deductible_cents, paypal_capture_id, statement_descriptor, lines, glim_recap
     from receipts where event_id = $1 and paddle_id = $2`,
    [eventId, paddleId],
  );
  return rows;
}

/** Waits until this many backends of the test database are blocked on a lock. */
export async function untilWaitingOnLocks(pool: pg.Pool, count: number): Promise<void> {
  for (let tries = 0; tries < 500; tries += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} backends started waiting on a lock`);
}

/** What the worker's lease does for a crashed worker, without waiting two minutes. */
export async function expireLeases(pool: pg.Pool, eventId: string): Promise<void> {
  await pool.query(
    `update settlement_items i set next_attempt_at = clock_timestamp() - interval '1 second'
     from settlements s
     where s.id = i.settlement_id and s.event_id = $1 and i.next_attempt_at is not null`,
    [eventId],
  );
}
