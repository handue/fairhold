/**
 * Charging on Postgres, against PayPal's rules at the wire: the capture-or-void queue, its restart
 * and retry behavior, and the guards that stop a bad charge.
 */
import fc from "fast-check";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import { withTransaction } from "@/server/db/transaction";
import { fenceSettlement, retireDemo } from "@/server/director/retire";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { processSettlementQueue, retrySettlementItem, startSettlement, voidReplacedHolds } from "@/server/settlement";
import type { SettlementDependencies } from "@/server/settlement/dependencies";
import { invoiceIdFor, noteToPayerFor } from "@/server/settlement/plan";

import { getTestDatabase } from "../../helpers/database";
import { authorizationBody, json, paypalError } from "../../unit/paypal/fake-paypal";
import { createPaddle } from "../engine/support/fixtures";

import {
  dependenciesFor,
  eventRow,
  expireLeases,
  holdRow,
  insertRealHold,
  itemOf,
  itemsOf,
  paypalWorld,
  receiptOf,
  runGala,
  untilWaitingOnLocks,
  type PaypalWorld,
} from "./support";

const { pool, db } = getTestDatabase();

const JAMIE = 142;
const KAI = 143;
const SIMULATED = 175;
const SIMULATED_LOSER = 176;

function setup() {
  const world = paypalWorld();
  return { world, deps: dependenciesFor(pool, db, world.payments) };
}

/** Two real guests and two simulated ones: a winner and a loser of each kind. */
async function mixedGala(world: PaypalWorld) {
  return runGala(pool, world, {
    real: [
      { number: JAMIE, holdCents: 50_000 },
      { number: KAI, holdCents: 25_000 },
    ],
    simulated: [
      { number: SIMULATED, holdCents: 200_000 },
      { number: SIMULATED_LOSER, holdCents: 50_000 },
    ],
    wins: [
      { number: JAMIE, lot: 7, cents: 38_000 },
      { number: JAMIE, lot: 12, cents: 9_000 },
      { number: SIMULATED, lot: 1, cents: 145_000 },
    ],
  });
}

async function start(eventId: string, deps: SettlementDependencies) {
  const started = await startSettlement({ eventId, startedBySessionId: null }, deps);
  if (started.kind !== "started") throw new Error(`Settlement did not start: ${started.kind}`);
  return started;
}

/** The pool until `failing()` turns true; then every query fails, like a database that went away. */
function poolThatDies(failing: () => boolean): pg.Pool {
  return new Proxy(pool, {
    get(target, property, receiver) {
      if (failing() && (property === "query" || property === "connect")) {
        return () => Promise.reject(new Error("Connection terminated unexpectedly"));
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("charging winners and releasing everyone else", () => {
  it("captures the won total with final_capture, voids the original id, and settles simulated guests in the database", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);
    await start(gala.eventId, deps);

    expect(await processSettlementQueue(deps)).toMatchObject({ processed: 4, finished: 1 });

    const jamie = gala.holds.get(JAMIE);
    const kai = gala.holds.get(KAI);
    expect(world.captures).toHaveLength(1);
    expect(world.captures[0]).toMatchObject({
      authorizationId: jamie?.authorizationId,
      amountCents: 47_000,
      finalCapture: true,
      invoiceId: invoiceIdFor(gala.eventId, JAMIE),
      noteToPayer: noteToPayerFor("Riverside Animal Shelter"),
    });
    expect(world.voids).toEqual([
      { authorizationId: kai?.authorizationId, requestId: (await itemOf(pool, gala.eventId, KAI)).paypal_request_id },
    ]);

    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({
      action: "capture",
      status: "succeeded",
      amount_cents: 47_000,
      released_cents: 3_000,
      paypal_capture_id: world.captures[0]?.captureId,
      error_code: null,
    });
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ action: "void", status: "succeeded", amount_cents: 0, released_cents: 25_000 });
    expect(await itemOf(pool, gala.eventId, SIMULATED)).toMatchObject({
      action: "simulate",
      status: "succeeded",
      amount_cents: 145_000,
      released_cents: 55_000,
      paypal_capture_id: null,
    });
    expect(await itemOf(pool, gala.eventId, SIMULATED_LOSER)).toMatchObject({ action: "simulate", status: "succeeded", released_cents: 50_000 });

    await expect(holdRow(pool, jamie?.holdId ?? "")).resolves.toMatchObject({ status: "captured", captured_cents: 47_000 });
    await expect(holdRow(pool, kai?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });
    await expect(holdRow(pool, gala.holds.get(SIMULATED)?.holdId ?? "")).resolves.toMatchObject({ status: "captured", captured_cents: 145_000 });
    await expect(holdRow(pool, gala.holds.get(SIMULATED_LOSER)?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });

    const event = await eventRow(pool, gala.eventId);
    expect(event).toMatchObject({ status: "settled", settlement_status: "done" });
    expect(event.settled_at).toBeInstanceOf(Date);
  });

  it("voids guests who never bid too", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: [{ number: KAI, holdCents: 25_000 }],
      simulated: [{ number: SIMULATED, holdCents: 50_000 }],
      wins: [{ number: SIMULATED, lot: 1, cents: 10_000 }],
    });
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    expect(world.voids).toHaveLength(1);
    expect(world.authorizations.get(gala.holds.get(KAI)?.authorizationId ?? "")?.status).toBe("VOIDED");
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("writes what the stream needs, row by row, and in order", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);
    const { settlementId } = await start(gala.eventId, deps);
    await processSettlementQueue(deps);

    const { rows } = await pool.query<{ type: string; paddle_id: string | null; payload: { kind?: string; status?: string; paddleNumber?: number } }>(
      "select type, paddle_id, payload from event_log where event_id = $1 and type in ('settlement', 'event_status') order by id",
      [gala.eventId],
    );
    const kinds = rows.map((row) => row.payload.kind);
    expect(kinds).toContain("event_settling");
    expect(kinds).toContain("settlement_started");
    expect(kinds.at(-2)).toBe("settlement_finished");
    expect(kinds.at(-1)).toBe("event_settled");
    expect(rows.find((row) => row.payload.kind === "settlement_started")?.paddle_id).toBeNull();

    const jamie = rows.filter((row) => row.paddle_id === gala.paddles.get(JAMIE));
    expect(jamie.map((row) => row.payload.status)).toEqual(["processing", "processing", "succeeded"]);
    expect(jamie.at(-1)?.payload).toMatchObject({
      kind: "settlement_item",
      settlementId,
      paddleNumber: JAMIE,
      action: "capture",
      amountCents: 47_000,
      releasedCents: 3_000,
      paypalCaptureId: world.captures[0]?.captureId,
      errorCode: null,
    });
  });
});

describe("a double click", () => {
  it("runs one settlement and one capture per item, however many starts and queues race", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);

    const started = await Promise.all(
      Array.from({ length: 6 }, () => startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps)),
    );
    const ids = new Set(started.map((result) => ("settlementId" in result ? result.settlementId : null)));
    expect(ids.size).toBe(1);
    expect(started.filter((result) => result.kind === "started")).toHaveLength(1);

    await Promise.all([processSettlementQueue(deps), processSettlementQueue(deps), processSettlementQueue(deps)]);

    expect(world.captures).toHaveLength(1);
    expect(world.voids).toHaveLength(1);
    expect(await itemsOf(pool, gala.eventId)).toHaveLength(4);
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(1);

    // A click after it finished changes nothing either.
    const again = await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    expect(again.kind).toBe("already_started");
    await processSettlementQueue(deps);
    expect(world.posts("capture", gala.holds.get(JAMIE)?.authorizationId ?? "")).toHaveLength(1);
  });
});

describe("a crash", () => {
  it("between PayPal's capture and storing it: the lease runs out and the same request id replays, with no second charge", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";

    // The moment PayPal has captured, the database is gone for this worker: it dies with nothing stored.
    const crashed = { pool: poolThatDies(() => world.captures.length > 0) };
    await processSettlementQueue({ ...deps, ...crashed }).catch(() => {});

    expect(world.captures).toHaveLength(1);
    const stuck = await itemOf(pool, gala.eventId, JAMIE);
    expect(stuck).toMatchObject({ status: "processing", paypal_capture_id: null });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(0);

    // A restart finds it held by the lease until that runs out.
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "processing" });
    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);

    const posts = world.posts("capture", authorizationId);
    expect(posts.length).toBeGreaterThan(1);
    expect(new Set(posts.map((post) => post.headers["paypal-request-id"])).size).toBe(1);
    expect(world.captures).toHaveLength(1);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: world.captures[0]?.captureId });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "captured", captured_cents: 47_000 });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("after storing the capture: the next claim does not capture again, it only reads back", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: [{ number: JAMIE, holdCents: 50_000 }],
      wins: [{ number: JAMIE, lot: 7, cents: 32_000 }],
    });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";

    // The capture committed, and the process dies during the read-back.
    let dead = false;
    const authorization = world.authorizations.get(authorizationId);
    world.paypal.on("GET", `/v2/payments/authorizations/${authorizationId}`, () => {
      dead = true;
      return json(200, authorizationBody(authorizationId, authorization?.status ?? "CAPTURED", "500.00"));
    });
    await processSettlementQueue({ ...deps, pool: poolThatDies(() => dead) }).catch(() => {});

    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "processing", paypal_capture_id: world.captures[0]?.captureId });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "captured" });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "running" });

    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);

    expect(world.posts("capture", authorizationId)).toHaveLength(1);
    expect(world.captures).toHaveLength(1);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: world.captures[0]?.captureId });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("survives a new process: the queue is only rows, so nothing else has to remember it", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);
    await start(gala.eventId, deps);
    expect(await itemsOf(pool, gala.eventId)).toHaveLength(4);

    // The process that started the settlement is gone before it charged anyone.
    const restarted = dependenciesFor(pool, db, world.payments);
    await processSettlementQueue(restarted);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });

  it("right before finishing: the next run finishes the settlement", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { simulated: [{ number: SIMULATED, holdCents: 50_000 }], wins: [{ number: SIMULATED, lot: 1, cents: 1_000 }] });
    await start(gala.eventId, deps);
    await pool.query(
      `update settlement_items i set status = 'succeeded' from settlements s where s.id = i.settlement_id and s.event_id = $1`,
      [gala.eventId],
    );
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "running" });
    expect(await processSettlementQueue(deps)).toMatchObject({ processed: 0, finished: 1 });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });
});

describe("a declined capture, then a retry", () => {
  it("fails the row, charges nobody, leaves the others alone, and retries as a new request with the same invoice", async () => {
    const { world, deps } = setup();
    const gala = await mixedGala(world);
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    world.failNext("capture", authorizationId, () => paypalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-decline"));

    await processSettlementQueue(deps);

    const failed = await itemOf(pool, gala.eventId, JAMIE);
    expect(failed).toMatchObject({ status: "failed", error_code: "INSTRUMENT_DECLINED", next_attempt_at: null });
    expect(world.captures).toHaveLength(0);
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(0);
    // One failure does not stop the others, and the event stays settling for the retry.
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ status: "succeeded" });
    expect(await itemOf(pool, gala.eventId, SIMULATED)).toMatchObject({ status: "succeeded" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "done_with_errors" });
    // Nothing brings it back until the organizer asks.
    expect(await processSettlementQueue(deps)).toMatchObject({ processed: 0 });

    expect(await retrySettlementItem(gala.eventId, failed.id, deps)).toEqual({ kind: "queued" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "running" });
    // A double click on Retry is a no-op.
    expect(await retrySettlementItem(gala.eventId, failed.id, deps)).toEqual({ kind: "not_retryable", status: "queued" });

    await processSettlementQueue(deps);

    const posts = world.posts("capture", authorizationId);
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers["paypal-request-id"]).toBe(paypalRequestId("capture", failed.id));
    expect(posts[1]?.headers["paypal-request-id"]).toBe(paypalRequestId("capture", failed.id, 2));
    const invoices = posts.map((post) => (JSON.parse(post.body ?? "{}") as { invoice_id: string }).invoice_id);
    expect(new Set(invoices)).toEqual(new Set([invoiceIdFor(gala.eventId, JAMIE)]));
    expect(world.captures).toHaveLength(1);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: world.captures[0]?.captureId, error_code: null });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });

  it("treats a capture PayPal answers with status DECLINED the same way", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    world.failNext("capture", gala.holds.get(JAMIE)?.authorizationId ?? "", () =>
      json(201, { id: "DECLINED1", status: "DECLINED", amount: { currency_code: "USD", value: "320.00" } }),
    );
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "failed", error_code: "CAPTURE_DECLINED" });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(0);
  });

  it("keeps the request ids of later attempts distinct", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    const decline = () => paypalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-decline");
    world.failNext("capture", authorizationId, decline);
    world.failNext("capture", authorizationId, decline);

    for (let round = 0; round < 3; round += 1) {
      await processSettlementQueue(deps);
      const item = await itemOf(pool, gala.eventId, JAMIE);
      if (item.status === "failed") await retrySettlementItem(gala.eventId, item.id, deps);
    }

    const ids = world.posts("capture", authorizationId).map((post) => post.headers["paypal-request-id"]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(world.captures).toHaveLength(1);
  });
});

describe("no decided outcome", () => {
  it("keeps the request id after an answer this app could not read, because the money may have moved", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    world.failNext("capture", authorizationId, () => json(201, { status: "COMPLETED" }));

    await processSettlementQueue(deps);
    const item = await itemOf(pool, gala.eventId, JAMIE);
    expect(item).toMatchObject({ status: "queued", error_code: "UNEXPECTED_RESPONSE", paypal_request_id: paypalRequestId("capture", item.id) });

    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);
    expect(new Set(world.posts("capture", authorizationId).map((post) => post.headers["paypal-request-id"])).size).toBe(1);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded" });
  });

  it("backs off and retries with the same request id, and a later success counts", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    world.failNext("capture", authorizationId, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));
    world.failNext("capture", authorizationId, () => paypalError(409, "RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS", "debug-409"));

    await processSettlementQueue(deps);
    const waiting = await itemOf(pool, gala.eventId, JAMIE);
    expect(waiting).toMatchObject({ status: "queued", error_code: "INTERNAL_SERVER_ERROR", attempts: 1 });
    expect(waiting.next_attempt_at?.getTime()).toBeGreaterThan(Date.now());
    // Backoff: the next run leaves it alone until its time comes.
    expect(await processSettlementQueue(deps)).toMatchObject({ processed: 0 });

    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "queued", error_code: "PREVIOUS_REQUEST_IN_PROGRESS", attempts: 2 });

    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", attempts: 3, error_code: null });
    const ids = world.posts("capture", authorizationId).map((post) => post.headers["paypal-request-id"]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(world.captures).toHaveLength(1);
  });

  it("gives up after five tries and shows failed, and a retry keeps the id, because the first try may have charged", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    for (let tries = 0; tries < 5; tries += 1) {
      world.failNext("capture", authorizationId, () => paypalError(503, "SERVICE_UNAVAILABLE", null, "debug-503"));
    }

    for (let tries = 0; tries < 5; tries += 1) {
      await processSettlementQueue(deps);
      await expireLeases(pool, gala.eventId);
    }
    const failed = await itemOf(pool, gala.eventId, JAMIE);
    expect(failed).toMatchObject({ status: "failed", attempts: 5, paypal_request_id: paypalRequestId("capture", failed.id) });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "done_with_errors" });

    await retrySettlementItem(gala.eventId, failed.id, deps);
    await processSettlementQueue(deps);
    const ids = world.posts("capture", authorizationId).map((post) => post.headers["paypal-request-id"]);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(1);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", attempts: 6 });
  });

  it("gives a void the same treatment", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: KAI, holdCents: 25_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(KAI)?.authorizationId ?? "";
    world.failNext("void", authorizationId, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ status: "queued" });
    await expireLeases(pool, gala.eventId);
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ status: "succeeded" });
    expect(new Set(world.posts("void", authorizationId).map((post) => post.headers["paypal-request-id"])).size).toBe(1);
  });
});

describe("voids", () => {
  it("treats PREVIOUSLY_VOIDED as done", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: KAI, holdCents: 25_000 }] });
    await start(gala.eventId, deps);
    world.failNext("void", gala.holds.get(KAI)?.authorizationId ?? "", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", "debug-voided"),
    );
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ status: "succeeded", error_code: null });
    await expect(holdRow(pool, gala.holds.get(KAI)?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("fails the row on a refusal it cannot read as done, and voids on the original id, never a reauthorized one", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: KAI, holdCents: 25_000 }] });
    const hold = gala.holds.get(KAI);
    world.authorize("RENEWED1", 25_000, hold?.authorizationId ?? null);
    await pool.query("update holds set current_authorization_id = 'RENEWED1' where id = $1", [hold?.holdId]);
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    expect(world.voids[0]?.authorizationId).toBe(hold?.authorizationId);
    expect(world.posts("void", "RENEWED1")).toHaveLength(0);
    await expect(holdRow(pool, hold?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });
  });

  it("marks a failed void so the organizer sees it", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: KAI, holdCents: 25_000 }] });
    await start(gala.eventId, deps);
    world.failNext("void", gala.holds.get(KAI)?.authorizationId ?? "", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED", "debug-cap"),
    );
    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, KAI)).toMatchObject({ status: "failed", error_code: "PREVIOUSLY_CAPTURED" });
    const { rows } = await pool.query<{ code: string; paypal_debug_id: string }>(
      "select code, paypal_debug_id from error_log where event_id = $1 and source = 'settlement'",
      [gala.eventId],
    );
    expect(rows).toEqual([{ code: "PREVIOUSLY_CAPTURED", paypal_debug_id: "debug-cap" }]);
  });
});

describe("the void for a hold that was replaced", () => {
  /** A raise whose old authorization was never released: its void failed, so it stays replaced. */
  async function raisedGala(world: PaypalWorld) {
    const gala = await runGala(pool, world, {
      real: [{ number: JAMIE, holdCents: 70_000 }],
      wins: [{ number: JAMIE, lot: 7, cents: 32_000 }],
    });
    const paddleId = gala.paddles.get(JAMIE) ?? "";
    const old = await insertRealHold(pool, gala.eventId, paddleId, { amountCents: 50_000, status: "replaced" });
    await pool.query("update holds set replaced_by_hold_id = $2 where id = $1", [old.holdId, gala.holds.get(JAMIE)?.holdId]);
    world.authorize(old.authorizationId, 50_000);
    return { gala, old };
  }

  it("is retried when the settlement finishes, under the hold's own request id", async () => {
    const { world, deps } = setup();
    const { gala, old } = await raisedGala(world);
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);

    expect(world.authorizations.get(old.authorizationId)?.status).toBe("VOIDED");
    expect(world.voids).toEqual([{ authorizationId: old.authorizationId, requestId: paypalRequestId("void", old.holdId) }]);
    await expect(holdRow(pool, old.holdId)).resolves.toMatchObject({ status: "voided" });
    // Only the hold in place was charged.
    expect(world.captures).toHaveLength(1);
    expect(world.captures[0]?.authorizationId).toBe(gala.holds.get(JAMIE)?.authorizationId);
    expect(await itemsOf(pool, gala.eventId)).toHaveLength(1);
  });

  it("counts PREVIOUSLY_VOIDED as done, and stays replaced with the failure recorded when PayPal is out", async () => {
    const { world, deps } = setup();
    const { gala, old } = await raisedGala(world);

    world.failNext("void", old.authorizationId, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));
    await expect(voidReplacedHolds({ eventId: gala.eventId }, deps)).resolves.toEqual({ voided: 0, failed: 1 });
    await expect(holdRow(pool, old.holdId)).resolves.toMatchObject({ status: "replaced" });

    world.failNext("void", old.authorizationId, () => paypalError(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", "debug-voided"));
    await expect(voidReplacedHolds({ eventId: gala.eventId }, deps)).resolves.toEqual({ voided: 1, failed: 0 });
    await expect(holdRow(pool, old.holdId)).resolves.toMatchObject({ status: "voided" });
  });

  it("leaves a replaced hold with no authorization alone", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { simulated: [{ number: SIMULATED, holdCents: 50_000 }] });
    const { rows } = await pool.query<{ id: string }>(
      "insert into holds (event_id, paddle_id, kind, amount_cents, status) values ($1, $2, 'simulated', 100, 'replaced') returning id",
      [gala.eventId, gala.paddles.get(SIMULATED)],
    );
    await expect(voidReplacedHolds({ eventId: gala.eventId }, deps)).resolves.toEqual({ voided: 0, failed: 0 });
    await expect(holdRow(pool, rows[0]?.id ?? "")).resolves.toMatchObject({ status: "replaced" });
  });
});

describe("no capture exceeds its authorization", () => {
  it("refuses at the last moment if the hold no longer covers the item, without calling PayPal", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    await pool.query("update holds set amount_cents = 30000 where id = $1", [gala.holds.get(JAMIE)?.holdId]);

    await processSettlementQueue(deps);

    expect(world.posts("capture", gala.holds.get(JAMIE)?.authorizationId ?? "")).toHaveLength(0);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "failed", error_code: "OVER_AUTHORIZATION" });
  });

  it("does not charge a hold PayPal or the sweep already ended", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    await pool.query("update holds set status = 'expired' where id = $1", [gala.holds.get(JAMIE)?.holdId]);
    await processSettlementQueue(deps);
    expect(world.posts("capture", gala.holds.get(JAMIE)?.authorizationId ?? "")).toHaveLength(0);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "failed", error_code: "HOLD_EXPIRED" });
  });

  it("holds over random galas: every capture is the won total, within its authorization, and the money adds up", async () => {
    const runs = Math.max(10, Math.floor(Number(process.env.FAST_CHECK_RUNS ?? 200) / 10));
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ holdDollars: fc.integer({ min: 25, max: 1_000 }), real: fc.boolean(), wins: fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 4 }) }), { minLength: 1, maxLength: 6 }),
        async (guests) => {
          const world = paypalWorld();
          const deps = dependenciesFor(pool, db, world.payments);
          let lot = 1;
          const wins: { number: number; lot: number; cents: number }[] = [];
          const real: { number: number; holdCents: number }[] = [];
          const simulated: { number: number; holdCents: number }[] = [];
          const expected = new Map<number, { hold: number; won: number; real: boolean }>();
          guests.forEach((guest, index) => {
            const number = 100 + index;
            const hold = guest.holdDollars * 100;
            let won = 0;
            for (const dollars of guest.wins) {
              // Bids that would pass the hold are never accepted, so a gala only holds those that fit.
              if (won + dollars * 100 > hold) continue;
              won += dollars * 100;
              wins.push({ number, lot, cents: dollars * 100 });
              lot += 1;
            }
            (guest.real ? real : simulated).push({ number, holdCents: hold });
            expected.set(number, { hold, won, real: guest.real });
          });

          const gala = await runGala(pool, world, { real, simulated, wins });
          await start(gala.eventId, deps);
          await processSettlementQueue(deps);

          for (const capture of world.captures) {
            const authorization = world.authorizations.get(capture.authorizationId);
            expect(capture.amountCents).toBeLessThanOrEqual(authorization?.amountCents ?? 0);
            expect(capture.finalCapture).toBe(true);
          }
          const invoices = world.captures.map((capture) => capture.invoiceId);
          expect(new Set(invoices).size).toBe(invoices.length);
          expect(world.captures).toHaveLength([...expected.values()].filter((guest) => guest.real && guest.won > 0).length);
          expect(world.voids).toHaveLength([...expected.values()].filter((guest) => guest.real && guest.won === 0).length);
          for (const item of await itemsOf(pool, gala.eventId)) {
            const guest = expected.get(item.paddle_number);
            expect(item.status).toBe("succeeded");
            expect(item.amount_cents).toBe(guest?.won);
            expect(item.amount_cents + item.released_cents).toBe(guest?.hold);
          }
          expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
        },
      ),
      { numRuns: runs },
    );
  }, 120_000);
});

describe("invoice ids", () => {
  it("are unique per item, across paddles and across events", async () => {
    const { world, deps } = setup();
    const first = await runGala(pool, world, {
      real: [
        { number: JAMIE, holdCents: 50_000 },
        { number: KAI, holdCents: 50_000 },
      ],
      wins: [
        { number: JAMIE, lot: 7, cents: 32_000 },
        { number: KAI, lot: 9, cents: 22_000 },
      ],
    });
    const second = await runGala(pool, world, {
      real: [{ number: JAMIE, holdCents: 50_000 }],
      wins: [{ number: JAMIE, lot: 7, cents: 32_000 }],
    });
    await start(first.eventId, deps);
    await start(second.eventId, deps);
    await processSettlementQueue(deps);

    expect(world.captures).toHaveLength(3);
    const invoices = world.captures.map((capture) => capture.invoiceId);
    expect(new Set(invoices).size).toBe(3);
    expect(invoices).toContain(`FH-${first.eventId}-${JAMIE}`);
    expect(invoices).toContain(`FH-${first.eventId}-${KAI}`);
    expect(invoices).toContain(`FH-${second.eventId}-${JAMIE}`);
    for (const invoice of invoices) expect(invoice.length).toBeLessThanOrEqual(127);
  });

  it("a duplicate that PayPal says was captured waits for the capture's webhook; one that was not fails", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    const authorization = world.authorizations.get(authorizationId);
    world.failNext("capture", authorizationId, () => {
      if (authorization) authorization.status = "CAPTURED";
      return paypalError(422, "UNPROCESSABLE_ENTITY", "DUPLICATE_INVOICE_ID", "debug-dup");
    });

    await processSettlementQueue(deps);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "pending", error_code: "DUPLICATE_INVOICE_ID" });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ settlement_status: "done_with_errors" });

    const other = await runGala(pool, world, { real: [{ number: KAI, holdCents: 50_000 }], wins: [{ number: KAI, lot: 7, cents: 32_000 }] });
    await start(other.eventId, deps);
    world.failNext("capture", other.holds.get(KAI)?.authorizationId ?? "", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "DUPLICATE_INVOICE_ID", "debug-dup"),
    );
    await processSettlementQueue(deps);
    expect(await itemOf(pool, other.eventId, KAI)).toMatchObject({ status: "failed", error_code: "DUPLICATE_INVOICE_ID" });
  });
});

describe("the PARTIALLY_CAPTURED guard", () => {
  it("voids the rest on the original id when a read-back shows part of the hold still open", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    const item = await itemOf(pool, gala.eventId, JAMIE);
    const authorization = world.authorizations.get(authorizationId);
    world.failNext("capture", authorizationId, () => {
      // PayPal took the money but left the authorization open.
      if (authorization) authorization.status = "PARTIALLY_CAPTURED";
      return json(201, { id: "CAPPART", status: "COMPLETED", amount: { currency_code: "USD", value: "320.00" }, final_capture: true });
    });
    world.paypal.on("POST", `/v2/payments/authorizations/${authorizationId}/void`, (request) => {
      if (authorization) authorization.status = "CAPTURED";
      world.voids.push({ authorizationId, requestId: request.headers["paypal-request-id"] ?? "" });
      return { status: 204, headers: { "paypal-debug-id": "debug-204" }, body: "" };
    });

    await processSettlementQueue(deps);

    expect(world.voids).toEqual([{ authorizationId, requestId: paypalRequestId("void", item.id) }]);
    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: "CAPPART", error_code: null });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });

  it("does not void anything after an ordinary final capture", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    expect(world.voids).toEqual([]);
  });

  it("keeps the charge and leaves a note when the rest cannot be voided", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    const authorization = world.authorizations.get(authorizationId);
    world.failNext("capture", authorizationId, () => {
      if (authorization) authorization.status = "PARTIALLY_CAPTURED";
      return json(201, { id: "CAPPART", status: "COMPLETED", amount: { currency_code: "USD", value: "320.00" }, final_capture: true });
    });
    world.failNext("void", authorizationId, () => paypalError(422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_VOIDED", "debug-no"));

    await processSettlementQueue(deps);

    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: "CAPPART", error_code: "REMAINDER_NOT_RELEASED" });
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "captured" });
    expect(await receiptOf(pool, gala.eventId, gala.paddles.get(JAMIE) ?? "")).toHaveLength(1);
  });

  it("retries a read-back PayPal could not answer, then finishes with a note, and never charges again", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    const authorizationId = gala.holds.get(JAMIE)?.authorizationId ?? "";
    world.paypal.on("GET", `/v2/payments/authorizations/${authorizationId}`, () => paypalError(500, "INTERNAL_SERVER_ERROR", null, "debug-500"));

    for (let tries = 0; tries < 5; tries += 1) {
      await processSettlementQueue(deps);
      await expireLeases(pool, gala.eventId);
    }

    expect(await itemOf(pool, gala.eventId, JAMIE)).toMatchObject({ status: "succeeded", paypal_capture_id: world.captures[0]?.captureId, error_code: "READBACK_FAILED" });
    expect(world.posts("capture", authorizationId)).toHaveLength(1);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });
  });
});

describe("reauthorizing before the capture", () => {
  it("renews a hold past its honor period on a non-demo event, then captures the new id and voids the original", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: [
        { number: JAMIE, holdCents: 50_000, ageDays: 5 },
        { number: KAI, holdCents: 25_000, ageDays: 5 },
      ],
      wins: [{ number: JAMIE, lot: 7, cents: 32_000 }],
    });
    const jamie = gala.holds.get(JAMIE);
    await start(gala.eventId, deps);
    // start ran the checks, which renewed the winner's hold already; the loser only gets voided.
    expect(world.reauthorizations).toHaveLength(1);
    const renewed = world.reauthorizations[0];
    expect(renewed).toMatchObject({ authorizationId: jamie?.authorizationId, amountCents: 50_000 });
    expect(renewed?.requestId).toBe(paypalRequestId("reauthorize", jamie?.holdId ?? "", 1));

    await processSettlementQueue(deps);

    expect(world.captures[0]?.authorizationId).toBe(renewed?.newId);
    const stored = await holdRow(pool, jamie?.holdId ?? "");
    expect(stored).toMatchObject({ status: "captured", original_authorization_id: jamie?.authorizationId, current_authorization_id: renewed?.newId });
    expect(stored.reauthorized_at).toBeInstanceOf(Date);
    expect(stored.honor_until?.getTime()).toBeGreaterThan(Date.now());
    expect(world.voids[0]?.authorizationId).toBe(gala.holds.get(KAI)?.authorizationId);
  });

  it("renews in the queue too, when the honor period ended after the checks", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    const jamie = gala.holds.get(JAMIE);
    await start(gala.eventId, deps);
    await pool.query("update holds set authorized_at = now() - interval '4 days', honor_until = now() - interval '1 day' where id = $1", [jamie?.holdId]);

    await processSettlementQueue(deps);

    expect(world.reauthorizations).toHaveLength(1);
    expect(world.captures[0]?.authorizationId).toBe(world.reauthorizations[0]?.newId);
  });

  it("never renews a demo's hold", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      isDemo: true,
      real: [{ number: JAMIE, holdCents: 50_000, ageDays: 5 }],
      wins: [{ number: JAMIE, lot: 7, cents: 32_000 }],
    });
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    expect(world.reauthorizations).toEqual([]);
    expect(world.captures[0]?.authorizationId).toBe(gala.holds.get(JAMIE)?.authorizationId);
  });

  it("captures on the id in place when PayPal says it is too soon to renew", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000, ageDays: 3 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    const jamie = gala.holds.get(JAMIE);
    world.failNext("reauthorize", jamie?.authorizationId ?? "", () => paypalError(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_TOO_SOON", "debug-soon"));
    world.failNext("reauthorize", jamie?.authorizationId ?? "", () => paypalError(422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_TOO_SOON", "debug-soon"));
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    expect(world.captures[0]?.authorizationId).toBe(jamie?.authorizationId);
  });
});

describe("the paddle row comes first", () => {
  it("waits for a transaction holding the paddle row before it changes the hold", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);

    const engine = await pool.connect();
    await engine.query("begin");
    await engine.query("select id from paddles where id = $1 for no key update", [gala.paddles.get(JAMIE)]);

    const running = processSettlementQueue(deps);
    await untilWaitingOnLocks(pool, 1);
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "authorized" });

    await engine.query("commit");
    engine.release();
    await running;
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "captured" });
  });
});

describe("two organizers on one queue", () => {
  it("never let one hold be captured twice, with a slow PayPal and overlapping workers", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: Array.from({ length: 12 }, (_, index) => ({ number: 200 + index, holdCents: 50_000 })),
      wins: Array.from({ length: 12 }, (_, index) => ({ number: 200 + index, lot: index + 1, cents: 10_000 + index * 100 })),
    });
    await start(gala.eventId, deps);
    await Promise.all(Array.from({ length: 5 }, () => processSettlementQueue(deps)));
    expect(world.captures).toHaveLength(12);
    expect(new Set(world.captures.map((capture) => capture.authorizationId)).size).toBe(12);
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });
  });
});

describe("the store's guards", () => {
  it("createPostgresHoldStore's replaced-to-voided keeps a captured hold captured", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: JAMIE, holdCents: 50_000 }], wins: [{ number: JAMIE, lot: 7, cents: 32_000 }] });
    await start(gala.eventId, deps);
    await processSettlementQueue(deps);
    await createPostgresHoldStore(db).markReplacedVoided(gala.holds.get(JAMIE)?.holdId ?? "");
    await expect(holdRow(pool, gala.holds.get(JAMIE)?.holdId ?? "")).resolves.toMatchObject({ status: "captured" });
  });

  it("leaves a paddle with no hold and no wins out of the settlement", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { simulated: [{ number: SIMULATED, holdCents: 50_000 }] });
    await createPaddle(pool, gala.eventId, 301);
    await start(gala.eventId, deps);
    expect((await itemsOf(pool, gala.eventId)).map((item) => item.paddle_number)).toEqual([SIMULATED]);
  });
});

describe("retiring a demo beside an organizer's Retry", () => {
  async function doneWithErrors() {
    const world = paypalWorld();
    const deps = dependenciesFor(pool, db, world.payments);
    const gala = await runGala(pool, world, {
      isDemo: true,
      real: [{ number: 142, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    world.failNext("capture", gala.holds.get(142)?.authorizationId ?? "", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-declined"),
    );
    await processSettlementQueue(deps);
    return { world, deps, gala, item: await itemOf(pool, gala.eventId, 142) };
  }

  it("refuses a Retry once the demo is retired, and leaves the row as it was", async () => {
    const { world, deps, gala, item } = await doneWithErrors();
    expect(await retireDemo(pool, gala.eventId)).toBe("retired");

    expect(await retrySettlementItem(gala.eventId, item.id, deps)).toEqual({ kind: "not_retryable", status: "failed" });

    expect(await itemOf(pool, gala.eventId, 142)).toMatchObject({ status: "failed" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled", settlement_status: "done_with_errors" });
    await processSettlementQueue(deps);
    expect(world.captures).toHaveLength(0);
  });

  it("still retries while the event is settling", async () => {
    const { deps, gala, item } = await doneWithErrors();
    expect(await retrySettlementItem(gala.eventId, item.id, deps)).toEqual({ kind: "queued" });
  });

  it("waits for a Retry in flight, and then treats its settlement as running", async () => {
    const { gala } = await doneWithErrors();
    const retry = await pool.connect();
    try {
      await retry.query("begin");
      await retry.query("select id from events where id = $1 for share", [gala.eventId]);
      await retry.query("update settlements set status = 'running', finished_at = null where event_id = $1", [gala.eventId]);

      const fenced = withTransaction(pool, (client) => fenceSettlement(client, gala.eventId));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await retry.query("commit");

      expect(await fenced).toBe("settlement_running");
      expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling" });
    } finally {
      retry.release();
    }
  });
});
