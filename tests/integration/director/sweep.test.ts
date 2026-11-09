/** POST /api/cron/sweep on Postgres: the 6-hour cleanup, retried voids, expiry, and running twice. */
import { setTimeout as sleep } from "node:timers/promises";

import { beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/cron/sweep/route";
import { POST as control } from "@/app/api/events/[slug]/demo/[action]/route";
import { createSession, getSession, sessionCookieName } from "@/server/api";
import { createDemoEvent } from "@/server/demo/createDemoEvent";
import { endHold } from "@/server/director/holds";
import { runSweep, SWEEP_HEARTBEAT, SWEEP_LOCK, type SweepOptions } from "@/server/director/sweep";
import { closeEvent } from "@/server/engine";
import { PaypalError } from "@/server/paypal/errors";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { HoldKind, Payments, VoidRequest } from "@/server/paypal/payments";
import { getPayments } from "@/server/paypal/runtime";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

import { approveRealHold, jobsOf, rows, startGala, type DemoGala } from "./support";

const { pool, db } = getTestDatabase();

const BEARER = `Bearer ${"test-only-".repeat(4)}`;

beforeEach(async () => {
  await pool.query("delete from events; delete from rate_limits; delete from heartbeats; delete from error_log");
});

const sweepRequest = (authorization?: string) =>
  new Request("http://fairhold-web:10000/api/cron/sweep", {
    method: "POST",
    headers: authorization === undefined ? {} : { authorization },
  });
const routeSweep = (authorization: string | undefined = BEARER) => POST(sweepRequest(authorization), undefined);

/** Records every void, and can fail on demand. Everything else is the real keyless simulation. */
function spyingPayments(fail?: (request: VoidRequest) => PaypalError | null, watch?: () => Promise<void>) {
  const calls: { kind: HoldKind; request: VoidRequest; eventsAtCall: number }[] = [];
  const paymentsFor = (kind: HoldKind): Payments => {
    const payments = getPayments(kind);
    return Object.create(payments, {
      void: {
        value: async (request: VoidRequest) => {
          await watch?.();
          const eventsAtCall = (await rows<{ n: number }>(pool, "select count(*)::int as n from events"))[0]?.n ?? 0;
          calls.push({ kind, request, eventsAtCall });
          const failure = fail?.(request);
          if (failure) throw failure;
          return payments.void(request);
        },
      },
    }) as Payments;
  };
  return { calls, paymentsFor };
}

const sweep = (options: SweepOptions = {}) => runSweep({ pool, ...options });

async function expire(gala: DemoGala): Promise<void> {
  await pool.query("update events set demo_expires_at = now() - interval '1 second' where id = $1", [gala.eventId]);
}

const eventExists = async (eventId: string) => (await rows(pool, "select 1 from events where id = $1", [eventId])).length === 1;
const holdStatus = async (holdId: string) => (await rows<{ status: string }>(pool, "select status from holds where id = $1", [holdId]))[0]?.status;

const paypalDown = () => new PaypalError({ operation: "void", code: "INTERNAL_SERVER_ERROR", httpStatus: 500, debugId: "debug-500" });

describe("who may call the sweep", () => {
  it("refuses a missing or wrong bearer, and runs nothing", async () => {
    const gala = await startGala(pool);
    await expire(gala);
    for (const authorization of [undefined, "", "Bearer wrong", `Basic ${"test-only-".repeat(4)}`, `${BEARER}x`, BEARER.toLowerCase()]) {
      const response = await POST(sweepRequest(authorization), undefined);
      expect(response.status, String(authorization)).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
    expect(await eventExists(gala.eventId)).toBe(true);
    expect(await rows(pool, "select 1 from heartbeats")).toEqual([]);
  });

  it("answers the cron job, which sends no Origin, with its report", async () => {
    const response = await routeSweep();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ran: true,
      holdsExpired: 0,
      replacedVoided: 0,
      voidsFailed: 0,
      demosDeleted: 0,
      demosWaiting: 0,
      rateLimitsPruned: 0,
      errorLogPruned: 0,
      errors: [],
    });
  });
});

describe("error_log", () => {
  it("goes after 30 days, and no sooner", async () => {
    await pool.query(
      `insert into error_log (source, message, created_at)
       values ('api', 'old', now() - interval '31 days'), ('api', 'recent', now() - interval '29 days')`,
    );

    expect(await sweep()).toMatchObject({ errorLogPruned: 1, errors: [] });

    const { rows: left } = await pool.query<{ message: string }>("select message from error_log where message in ('old', 'recent')");
    expect(left).toEqual([{ message: "recent" }]);
  });
});

describe("the 6-hour demo cleanup", () => {
  it("voids a demo's real holds first, on their original ids, and then deletes it", async () => {
    const gala = await startGala(pool);
    const { holdId, authorizationId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await expire(gala);
    const { calls, paymentsFor } = spyingPayments();

    const report = await sweep({ paymentsFor });
    expect(report).toMatchObject({ demosDeleted: 1, demosWaiting: 0, voidsFailed: 0, errors: [] });

    // Simulated guests hold 85 authorizations in the data and never reach the payments interface.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      kind: "paypal",
      request: { authorizationId, idempotencyKey: paypalRequestId("void", holdId) },
    });
    expect(calls[0]?.eventsAtCall).toBe(1);
    expect((await getSimulatedPayments().getAuthorization(authorizationId)).status).toBe("VOIDED");

    expect(await eventExists(gala.eventId)).toBe(false);
    expect(await rows(pool, "select 1 from holds where event_id = $1", [gala.eventId])).toEqual([]);
    expect(await jobsOf(pool, gala.eventId)).toEqual([]);
  });

  it("does nothing the second time", async () => {
    const gala = await startGala(pool);
    await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await expire(gala);
    const { calls, paymentsFor } = spyingPayments();
    await sweep({ paymentsFor });
    const callsAfterFirst = calls.length;

    const report = await sweep({ paymentsFor });
    expect(report).toMatchObject({ ran: true, demosDeleted: 0, demosWaiting: 0, replacedVoided: 0, holdsExpired: 0, voidsFailed: 0 });
    expect(calls).toHaveLength(callsAfterFirst);
  });

  it("leaves alone a demo still inside its 6 hours, and every other event", async () => {
    const fresh = await startGala(pool);
    const { holdId } = await approveRealHold(pool, fresh.eventId, fresh.jamie, 50_000);
    const { calls, paymentsFor } = spyingPayments();
    const report = await sweep({ paymentsFor });
    expect(report.demosDeleted).toBe(0);
    expect(calls).toEqual([]);
    expect(await eventExists(fresh.eventId)).toBe(true);
    expect(await holdStatus(holdId)).toBe("authorized");

    await pool.query("update events set is_demo = false, demo_expires_at = now() - interval '1 hour' where id = $1", [fresh.eventId]);
    expect((await sweep({ paymentsFor })).demosDeleted).toBe(0);
    expect(await eventExists(fresh.eventId)).toBe(true);
  });

  it("keeps a demo whose void failed, records why, and finishes on a later sweep", async () => {
    const gala = await startGala(pool);
    const { holdId, authorizationId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await expire(gala);

    const down = spyingPayments(paypalDown);
    const first = await sweep({ paymentsFor: down.paymentsFor });
    expect(first).toMatchObject({ demosDeleted: 0, demosWaiting: 1, voidsFailed: 1, errors: [] });
    expect(await eventExists(gala.eventId)).toBe(true);
    expect(await holdStatus(holdId)).toBe("authorized");
    const [logged] = await rows<{ source: string; code: string; paypal_debug_id: string; event_id: string; paddle_id: string }>(
      pool,
      "select source, code, paypal_debug_id, event_id, paddle_id from error_log where event_id = $1",
      [gala.eventId],
    );
    expect(logged).toEqual({ source: "cron", code: "INTERNAL_SERVER_ERROR", paypal_debug_id: "debug-500", event_id: gala.eventId, paddle_id: gala.jamie });
    const [held] = await rows<{ paypal_debug_id: string; raw: { last_error: { code: string } } }>(pool, "select paypal_debug_id, raw from holds where id = $1", [holdId]);
    expect(held).toMatchObject({ paypal_debug_id: "debug-500", raw: { last_error: { code: "INTERNAL_SERVER_ERROR" } } });

    // The retry reuses the request id, so PayPal can never void twice under two ids.
    const up = spyingPayments();
    const second = await sweep({ paymentsFor: up.paymentsFor });
    expect(second).toMatchObject({ demosDeleted: 1, demosWaiting: 0, voidsFailed: 0 });
    expect(up.calls[0]?.request.idempotencyKey).toBe(down.calls[0]?.request.idempotencyKey);
    expect((await getSimulatedPayments().getAuthorization(authorizationId)).status).toBe("VOIDED");
    expect(await eventExists(gala.eventId)).toBe(false);
  });

  it("treats an authorization already voided, or unknown to PayPal, as nothing left to void", async () => {
    for (const code of ["PREVIOUSLY_VOIDED", "AUTHORIZATION_VOIDED", "INVALID_RESOURCE_ID", "RESOURCE_NOT_FOUND"]) {
      const gala = await startGala(pool);
      await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
      await expire(gala);
      const { paymentsFor } = spyingPayments(() => new PaypalError({ operation: "void", code, httpStatus: 422 }));
      expect(await sweep({ paymentsFor }), code).toMatchObject({ demosDeleted: 1, voidsFailed: 0 });
    }
  });

  it("closes a demo still running past its limit, through the engine, before it voids anything", async () => {
    const gala = await startGala(pool);
    const { holdId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await expire(gala);
    let lotsOpenAtVoid = -1;
    const { paymentsFor } = spyingPayments(undefined, async () => {
      const [open] = await rows<{ n: number }>(pool, "select count(*)::int as n from lots where event_id = $1 and status = 'open'", [gala.eventId]);
      lotsOpenAtVoid = open?.n ?? -1;
    });
    await sweep({ paymentsFor });
    expect(lotsOpenAtVoid).toBe(0);
    expect(await holdStatus(holdId)).toBeUndefined();
  });

  it("waits for a settlement that is still charging, and goes once it has ended", async () => {
    const gala = await startGala(pool);
    const { holdId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await closeEvent(gala.eventId, { pool });
    await pool.query("update events set status = 'settling' where id = $1", [gala.eventId]);
    await pool.query("insert into settlements (event_id, status) values ($1, 'running')", [gala.eventId]);
    await expire(gala);

    const { calls, paymentsFor } = spyingPayments();
    expect(await sweep({ paymentsFor })).toMatchObject({ demosDeleted: 0, demosWaiting: 1 });
    expect(calls).toEqual([]);
    expect(await holdStatus(holdId)).toBe("authorized");

    await pool.query("update settlements set status = 'done_with_errors', finished_at = now() where event_id = $1", [gala.eventId]);
    expect(await sweep({ paymentsFor })).toMatchObject({ demosDeleted: 1, demosWaiting: 0 });
    expect(calls).toHaveLength(1);
  });

  it("voids a late approval that arrives after the demo was retired", async () => {
    const gala = await startGala(pool);
    await pool.query("update events set demo_expires_at = now() + interval '1 hour' where id = $1", [gala.eventId]);
    // The window is open and approved at PayPal when the organizer resets the demo.
    const { rows: pending } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', 50000) returning id",
      [gala.eventId, gala.jamie],
    );
    const holdId = pending[0]?.id ?? "";
    await closeEvent(gala.eventId, { pool });
    await pool.query("update events set status = 'settled' where id = $1", [gala.eventId]);

    const store = createPostgresHoldStore(db);
    const stored = await store.markAuthorized(holdId, {
      authorizationId: "AUTH-LATE",
      amountCents: 50_000,
      authorizedAt: new Date(),
      honorUntil: new Date(Date.now() + 86_400_000),
      expiresAt: new Date(Date.now() + 86_400_000),
      payer: { payerId: undefined, email: undefined, givenName: undefined, surname: undefined },
      raw: null,
    });
    expect(stored).toMatchObject({ kind: "refused", refusal: { reason: "bidding_ended" } });
    expect(await holdStatus(holdId)).toBe("replaced");

    const { calls, paymentsFor } = spyingPayments();
    const report = await sweep({ paymentsFor });
    expect(calls.map((call) => call.request.authorizationId)).toEqual(["AUTH-LATE"]);
    // The keyless simulation has never heard of it, so there is nothing left to void.
    expect(report).toMatchObject({ replacedVoided: 1, voidsFailed: 0 });
    expect(await holdStatus(holdId)).toBe("voided");
  });

  it("ends the old gala's sessions with it", async () => {
    const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    const created = await createSession({ eventId: event.id, paddleId: creator.paddleId, isOrganizer: true }, pool);
    const cookie = `${sessionCookieName(event.slug)}=${created.token}`;
    const request = new Request("https://fairhold.example/e", { headers: { cookie } });
    await expect(getSession(event.slug, request, pool)).resolves.toMatchObject({ isOrganizer: true });

    await pool.query("update events set demo_expires_at = now() where id = $1", [event.id]);
    await sweep();
    await expect(getSession(event.slug, request, pool)).resolves.toBeNull();
  });

  it("finishes what a Reset left: the reset gala goes on the next sweep", async () => {
    const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    const created = await createSession({ eventId: event.id, paddleId: creator.paddleId, isOrganizer: true, organizerName: "Sam" }, pool);
    const cookie = `${sessionCookieName(event.slug)}=${created.token}`;
    const reset = await control(postJson(`/api/events/${event.slug}/demo/reset`, {}, { cookie }), {
      params: Promise.resolve({ slug: event.slug, action: "reset" }),
    });
    expect(reset.status).toBe(201);
    expect(await eventExists(event.id)).toBe(true);

    const report = await sweep();
    expect(report).toMatchObject({ demosDeleted: 1, demosWaiting: 0 });
    expect(await eventExists(event.id)).toBe(false);
    expect((await rows<{ n: number }>(pool, "select count(*)::int as n from events where is_demo"))[0]?.n).toBe(1);
  });
});

describe("replaced holds", () => {
  async function replacedHold(gala: DemoGala) {
    const first = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    // A raise whose void failed: the old hold is replaced, and still live at PayPal.
    await pool.query("update holds set status = 'replaced' where id = $1", [first.holdId]);
    return first;
  }

  it("retries the void of every replaced hold that still has an authorization, on any event", async () => {
    const gala = await startGala(pool);
    const { holdId, authorizationId } = await replacedHold(gala);
    const { calls, paymentsFor } = spyingPayments();

    const report = await sweep({ paymentsFor });
    expect(report).toMatchObject({ replacedVoided: 1, voidsFailed: 0, demosDeleted: 0 });
    expect(calls[0]?.request).toMatchObject({ authorizationId, idempotencyKey: paypalRequestId("void", holdId) });
    expect(await holdStatus(holdId)).toBe("voided");
    expect((await getSimulatedPayments().getAuthorization(authorizationId)).status).toBe("VOIDED");
    const [row] = await rows<{ paddle_id: string; type: string }>(pool, "select paddle_id, type from event_log where type = 'hold' and payload->>'holdId' = $1 and payload->>'status' = 'voided'", [holdId]);
    expect(row).toEqual({ paddle_id: gala.jamie, type: "hold" });

    calls.length = 0;
    expect(await sweep({ paymentsFor })).toMatchObject({ replacedVoided: 0, voidsFailed: 0 });
    expect(calls).toEqual([]);
  });

  it("keeps trying while PayPal is down, and reuses the request id", async () => {
    const gala = await startGala(pool);
    const { holdId } = await replacedHold(gala);
    const down = spyingPayments(paypalDown);
    expect(await sweep({ paymentsFor: down.paymentsFor })).toMatchObject({ replacedVoided: 0, voidsFailed: 1 });
    expect(await holdStatus(holdId)).toBe("replaced");

    const up = spyingPayments();
    expect(await sweep({ paymentsFor: up.paymentsFor })).toMatchObject({ replacedVoided: 1, voidsFailed: 0 });
    expect(up.calls[0]?.request.idempotencyKey).toBe(down.calls[0]?.request.idempotencyKey);
  });

  it("does not touch a replaced hold with no authorization, a simulated guest's, or an authorized one", async () => {
    const gala = await startGala(pool);
    const { rows: empty } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents, status) values ($1, $2, 'paypal', 25000, 'replaced') returning id",
      [gala.eventId, gala.jamie],
    );
    const { rows: simulated } = await pool.query<{ id: string }>(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, original_authorization_id)
       values ($1, $2, 'simulated', 25000, 'replaced', 'SIMA1') returning id`,
      [gala.eventId, gala.paddle(88)],
    );
    const { holdId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    const { calls, paymentsFor } = spyingPayments();
    expect(await sweep({ paymentsFor })).toMatchObject({ replacedVoided: 0, voidsFailed: 0 });
    expect(calls).toEqual([]);
    expect(await holdStatus(empty[0]?.id ?? "")).toBe("replaced");
    expect(await holdStatus(simulated[0]?.id ?? "")).toBe("replaced");
    expect(await holdStatus(holdId)).toBe("authorized");
  });
});

describe("hold expiry", () => {
  it("marks authorized and replaced holds past their expiry, once, with a row on the paddle's channel", async () => {
    const gala = await startGala(pool);
    const held = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await pool.query("update holds set expires_at = now() - interval '1 minute' where id = $1", [held.holdId]);
    const { rows: replaced } = await pool.query<{ id: string }>(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, original_authorization_id, expires_at)
       values ($1, $2, 'paypal', 25000, 'replaced', 'OLD', now() - interval '1 minute') returning id`,
      [gala.eventId, gala.jamie],
    );
    const { calls, paymentsFor } = spyingPayments();

    expect(await sweep({ paymentsFor })).toMatchObject({ holdsExpired: 2, replacedVoided: 0 });
    expect(await holdStatus(held.holdId)).toBe("expired");
    expect(await holdStatus(replaced[0]?.id ?? "")).toBe("expired");
    // An expired authorization has nothing left to void.
    expect(calls).toEqual([]);
    const logged = await rows<{ paddle_id: string; payload: { status: string } }>(pool, "select paddle_id, payload from event_log where type = 'hold' and payload->>'status' = 'expired'");
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({ paddle_id: gala.jamie, payload: { status: "expired" } });

    expect(await sweep({ paymentsFor })).toMatchObject({ holdsExpired: 0 });
    expect(await rows(pool, "select 1 from event_log where type = 'hold' and payload->>'status' = 'expired'")).toHaveLength(2);
  });

  it("leaves holds ahead of their expiry alone, even one renewed after the sweep read it", async () => {
    const gala = await startGala(pool);
    const { holdId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    expect(await sweep()).toMatchObject({ holdsExpired: 0 });
    expect(await holdStatus(holdId)).toBe("authorized");

    expect(await endHold(pool, { id: holdId, paddleId: gala.jamie }, "expired", { onlyIfExpired: true })).toBe(false);
    expect(await holdStatus(holdId)).toBe("authorized");
  });

  it("takes the paddle row first, as every hold writer must", async () => {
    const gala = await startGala(pool);
    const { holdId } = await approveRealHold(pool, gala.eventId, gala.jamie, 50_000);
    await pool.query("update holds set expires_at = now() - interval '1 minute' where id = $1", [holdId]);

    const holder = await pool.connect();
    await holder.query("begin");
    await holder.query("select id from paddles where id = $1 for no key update", [gala.jamie]);
    const running = sweep();
    let waiting = false;
    for (let tries = 0; tries < 1_000 && !waiting; tries += 1) {
      const { rows: blocked } = await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
      );
      waiting = (blocked[0]?.n ?? 0) > 0;
      if (!waiting) await sleep(10);
    }
    expect(waiting).toBe(true);
    expect(await holdStatus(holdId)).toBe("authorized");
    await holder.query("rollback");
    holder.release();
    await expect(running).resolves.toMatchObject({ holdsExpired: 1 });
    expect(await holdStatus(holdId)).toBe("expired");
  });
});

describe("the rest of the sweep", () => {
  it("writes a heartbeat every time, with what it did", async () => {
    const gala = await startGala(pool);
    await expire(gala);
    const before = new Date();
    await sweep();
    const [beat] = await rows<{ name: string; beat_at: Date; detail: { demosDeleted: number } }>(pool, "select name, beat_at, detail from heartbeats");
    expect(beat?.name).toBe(SWEEP_HEARTBEAT);
    expect(beat?.detail.demosDeleted).toBe(1);
    expect(beat?.beat_at.getTime()).toBeGreaterThan(before.getTime() - 1_000);

    await sleep(5);
    await sweep();
    const [second] = await rows<{ beat_at: Date; detail: { demosDeleted: number } }>(pool, "select beat_at, detail from heartbeats");
    expect(second?.beat_at.getTime()).toBeGreaterThan(beat?.beat_at.getTime() ?? 0);
    expect(second?.detail.demosDeleted).toBe(0);
    expect(await rows(pool, "select 1 from heartbeats")).toHaveLength(1);
  });

  it("prunes old rate-limit windows and keeps today's", async () => {
    await pool.query(
      `insert into rate_limits (key, window_start, count) values
       ('old', now() - interval '2 days', 3), ('today', date_trunc('hour', now()), 3)`,
    );
    expect(await sweep()).toMatchObject({ rateLimitsPruned: 1 });
    expect(await rows<{ key: string }>(pool, "select key from rate_limits")).toEqual([{ key: "today" }]);
  });

  it("steps aside when another sweep is running", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock($1, $2)", [SWEEP_LOCK.namespace, SWEEP_LOCK.key]);
      expect(await sweep()).toMatchObject({ ran: false });
      expect(await rows(pool, "select 1 from heartbeats")).toEqual([]);
      await holder.query("select pg_advisory_unlock($1, $2)", [SWEEP_LOCK.namespace, SWEEP_LOCK.key]);
    } finally {
      holder.release();
    }
    expect(await sweep()).toMatchObject({ ran: true });
  });

  it("still reports through the route when a step cannot run, and beats anyway", async () => {
    const broken = {
      pool: new Proxy(pool, {
        get(target, property, receiver) {
          if (property !== "query") return Reflect.get(target, property, receiver) as unknown;
          return (text: string, ...rest: unknown[]) => {
            if (text.includes("from rate_limits")) return Promise.reject(new Error("the table is gone"));
            return (target.query as (...args: unknown[]) => unknown).call(target, text, ...rest);
          };
        },
      }),
    };
    const report = await sweep(broken);
    expect(report.errors).toEqual(["prune_rate_limits"]);
    expect(await rows(pool, "select 1 from heartbeats")).toHaveLength(1);
    const [logged] = await rows<{ code: string; message: string }>(pool, "select code, message from error_log where source = 'cron'");
    expect(logged).toEqual({ code: "sweep_step_failed", message: "the table is gone" });
  });

  it("cleans up two demos at once even when one of them cannot go yet", async () => {
    const stuck = await startGala(pool);
    const clean = await startGala(pool);
    await approveRealHold(pool, stuck.eventId, stuck.jamie, 50_000);
    await expire(stuck);
    await expire(clean);
    const { paymentsFor } = spyingPayments(paypalDown);
    expect(await sweep({ paymentsFor })).toMatchObject({ demosDeleted: 1, demosWaiting: 1, voidsFailed: 1 });
    expect(await eventExists(stuck.eventId)).toBe(true);
    expect(await eventExists(clean.eventId)).toBe(false);
  });
});
