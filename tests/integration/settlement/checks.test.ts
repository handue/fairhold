/** The checks on 12 before charging, and what they refuse. */
import { describe, expect, it } from "vitest";

import { closeEvent, placeBid } from "@/server/engine";
import { processSettlementQueue, runSettlementChecks, startSettlement } from "@/server/settlement";
import type { SettlementChecks } from "@/server/settlement/types";

import { getTestDatabase } from "../../helpers/database";
import { authorizationBody, json, paypalError } from "../../unit/paypal/fake-paypal";

import { dependenciesFor, eventRow, holdRow, itemsOf, paypalWorld, runGala } from "./support";

const { pool, db } = getTestDatabase();

function setup() {
  const world = paypalWorld();
  return { world, deps: dependenciesFor(pool, db, world.payments) };
}

const check = (checks: SettlementChecks, key: string) => checks.checks.find((item) => item.key === key);

describe("runSettlementChecks", () => {
  it("passes with a GET for each real hold and none for a simulated one", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 25_000 },
      ],
      simulated: [{ number: 175, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });

    const checks = await runSettlementChecks(gala.eventId, deps);

    expect(checks.passed).toBe(true);
    expect(check(checks, "winners_within_holds")).toMatchObject({ passed: true, count: 1, problems: [] });
    expect(check(checks, "holds_valid")).toMatchObject({ passed: true, count: 2, problems: [] });
    expect(check(checks, "glim_within_limits")).toMatchObject({ passed: true, count: 0, problems: [] });
    expect(typeof checks.ranAt).toBe("number");
    const gets = world.paypal.requests.filter((request) => request.method === "GET");
    expect(gets).toHaveLength(2);
  });

  it("fails when PayPal shows a winner's hold no longer CREATED", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    const authorization = world.authorizations.get(gala.holds.get(142)?.authorizationId ?? "");
    if (authorization) authorization.status = "VOIDED";

    const checks = await runSettlementChecks(gala.eventId, deps);

    expect(checks.passed).toBe(false);
    expect(check(checks, "holds_valid")).toMatchObject({
      passed: false,
      problems: [{ paddleNumber: 142, bidder: "Guest 142 T.", code: "VOIDED", blocking: true }],
    });
  });

  it("fails when a winner's authorization is past its expiry, and when it is too small", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });

    const later = { ...deps, now: () => new Date("2027-06-01T00:00:00Z") };
    expect((await runSettlementChecks(gala.eventId, later)).checks.find((item) => item.key === "holds_valid")?.problems[0]?.code).toBe("EXPIRED");

    const authorization = world.authorizations.get(gala.holds.get(142)?.authorizationId ?? "");
    if (authorization) authorization.amountCents = 30_000;
    expect((await runSettlementChecks(gala.eventId, deps)).checks.find((item) => item.key === "holds_valid")?.problems[0]?.code).toBe("over_authorization");
  });

  it("reports PayPal being out as a failed check, so charging stays off until it answers", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    const authorizationId = gala.holds.get(142)?.authorizationId ?? "";
    world.paypal.on("GET", `/v2/payments/authorizations/${authorizationId}`, () => paypalError(503, "SERVICE_UNAVAILABLE", null, "debug-503"));

    const checks = await runSettlementChecks(gala.eventId, deps);

    expect(checks.passed).toBe(false);
    expect(check(checks, "holds_valid")?.problems[0]).toMatchObject({ paddleNumber: 142, blocking: true });
  });

  it("only notes a hold that won nothing: it gets released, not charged", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 143, holdCents: 25_000 }] });
    const authorization = world.authorizations.get(gala.holds.get(143)?.authorizationId ?? "");
    if (authorization) authorization.status = "VOIDED";

    const checks = await runSettlementChecks(gala.eventId, deps);

    expect(checks.passed).toBe(true);
    expect(check(checks, "holds_valid")).toMatchObject({
      passed: true,
      problems: [{ paddleNumber: 143, code: "VOIDED", blocking: false }],
    });
  });

  it("finds a winner with no authorized hold, and a total over it", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });

    await pool.query("update holds set status = 'expired' where id = $1", [gala.holds.get(142)?.holdId]);
    expect(check(await runSettlementChecks(gala.eventId, deps), "winners_within_holds")).toMatchObject({
      passed: false,
      problems: [{ paddleNumber: 142, code: "no_hold" }],
    });

    await pool.query("update holds set status = 'authorized', amount_cents = 30000 where id = $1", [gala.holds.get(142)?.holdId]);
    expect(check(await runSettlementChecks(gala.eventId, deps), "winners_within_holds")).toMatchObject({
      passed: false,
      problems: [{ paddleNumber: 142, code: "over_hold" }],
    });
  });

  it("audits Glim's bids against their limits and the hold, from the bids themselves", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      simulated: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 50_000 },
      ],
      wins: [
        { number: 142, lot: 7, cents: 32_000 },
        { number: 143, lot: 9, cents: 22_000 },
      ],
    });
    const limit = async (paddle: number, lot: number, cents: number) => {
      const { rows } = await pool.query<{ id: string }>(
        "insert into bid_limits (paddle_id, lot_id, max_cents, owner, active, ended_at) values ($1, $2, $3, 'glim', false, now()) returning id",
        [gala.paddles.get(paddle), gala.lots.get(lot), cents],
      );
      await pool.query("update bids set source = 'glim', limit_id = $3 where lot_id = $1 and paddle_id = $2", [
        gala.lots.get(lot),
        gala.paddles.get(paddle),
        rows[0]?.id,
      ]);
    };
    await limit(142, 7, 38_000);
    await limit(143, 9, 22_000);
    expect(check(await runSettlementChecks(gala.eventId, deps), "glim_within_limits")).toMatchObject({ passed: true, count: 2, problems: [] });

    // A bid past its limit.
    await pool.query("update bid_limits set max_cents = 20000 where lot_id = $1", [gala.lots.get(9)]);
    expect(check(await runSettlementChecks(gala.eventId, deps), "glim_within_limits")).toMatchObject({
      passed: false,
      count: 2,
      problems: [{ paddleNumber: 143, code: "over_limit" }],
    });

    // A Glim bid no limit explains.
    await pool.query("update bids set limit_id = null where lot_id = $1", [gala.lots.get(7)]);
    const checks = await runSettlementChecks(gala.eventId, deps);
    expect(check(checks, "glim_within_limits")?.problems.map((problem) => problem.code)).toEqual(["no_limit", "over_limit"]);
    expect(checks.passed).toBe(false);
  });
});

describe("Glim's bids against the hold in place when they were placed", () => {
  /** A Glim bid of $320, under a hold of the given size: the engine itself would refuse one past it. */
  async function glimWinner(holdCents: number) {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      simulated: [{ number: 142, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    await pool.query("update holds set amount_cents = $2 where id = $1", [gala.holds.get(142)?.holdId, holdCents]);
    const { rows } = await pool.query<{ id: string }>(
      "insert into bid_limits (paddle_id, lot_id, max_cents, owner, active, ended_at) values ($1, $2, 40000, 'glim', false, now()) returning id",
      [gala.paddles.get(142), gala.lots.get(7)],
    );
    await pool.query("update bids set source = 'glim', limit_id = $2 where lot_id = $1", [gala.lots.get(7), rows[0]?.id]);
    return { deps, gala, holdId: gala.holds.get(142)?.holdId ?? "", paddleId: gala.paddles.get(142) ?? "" };
  }
  const glim = async ({ deps, gala }: Awaited<ReturnType<typeof glimWinner>>) =>
    check(await runSettlementChecks(gala.eventId, deps), "glim_within_limits");

  it("does not hold a bid within its hold against what became of the hold", async () => {
    const context = await glimWinner(50_000);
    for (const status of ["voided", "expired", "captured", "replaced"]) {
      await pool.query("update holds set status = $2 where id = $1", [context.holdId, status]);
      expect(await glim(context), status).toMatchObject({ passed: true, problems: [] });
    }
  });

  it("counts a raise from when it came, not before", async () => {
    const context = await glimWinner(30_000);
    const raise = async (authorizedAt: string) => {
      await pool.query("delete from holds where id <> $1 and paddle_id = $2", [context.holdId, context.paddleId]);
      await pool.query(
        `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
         values ($1, $2, 'simulated', 50000, 'replaced', ${authorizedAt})`,
        [context.gala.eventId, context.paddleId],
      );
    };
    expect(await glim(context)).toMatchObject({ passed: false, problems: [{ paddleNumber: 142, code: "over_hold", blocking: true }] });

    await raise("now() - interval '1 hour'");
    expect(await glim(context)).toMatchObject({ passed: true, problems: [] });

    await raise("now() + interval '1 hour'");
    expect(await glim(context)).toMatchObject({ passed: false, problems: [{ code: "over_hold" }] });
  });

  it("ignores windows that never held anything", async () => {
    const context = await glimWinner(30_000);
    for (const status of ["pending_approval", "canceled", "denied", "failed"]) {
      await pool.query(
        "insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at) values ($1, $2, 'simulated', 90000, $3, now() - interval '1 hour')",
        [context.gala.eventId, context.paddleId, status],
      );
    }
    expect(await glim(context)).toMatchObject({ passed: false, problems: [{ code: "over_hold" }] });
  });

  it("still names a problem on someone who won nothing, without blocking the charge", async () => {
    const context = await glimWinner(50_000);
    await pool.query("update bid_limits set max_cents = 100 where paddle_id = $1", [context.paddleId]);
    await pool.query("update lots set winning_paddle_id = null, winning_cents = null where id = $1", [context.gala.lots.get(7)]);

    expect(await glim(context)).toMatchObject({ passed: true, problems: [{ paddleNumber: 142, code: "over_limit", blocking: false }] });
  });
});

describe("startSettlement", () => {
  it("refuses while bidding is open, and moves nothing", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      live: true,
      real: [{ number: 142, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    await expect(startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps)).resolves.toEqual({ kind: "bidding_open" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "live", settlement_status: null });
    expect(world.paypal.apiRequests()).toHaveLength(0);
  });

  it("refuses a demo that was retired before anyone charged it", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    await pool.query("update events set status = 'settled', settled_at = now() where id = $1", [gala.eventId]);
    await expect(startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps)).resolves.toEqual({ kind: "event_ended" });
    expect(await itemsOf(pool, gala.eventId)).toEqual([]);
    expect(world.paypal.apiRequests()).toHaveLength(0);
  });

  it("refuses when a check fails, moves nothing, and starts once it passes", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    const authorizationId = gala.holds.get(142)?.authorizationId ?? "";
    const authorization = world.authorizations.get(authorizationId);
    if (authorization) authorization.status = "DENIED";

    const refused = await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    expect(refused).toMatchObject({ kind: "checks_failed", checks: { passed: false } });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "closed", settlement_status: null });
    expect(await itemsOf(pool, gala.eventId)).toEqual([]);
    expect(world.posts("capture", authorizationId)).toHaveLength(0);

    if (authorization) authorization.status = "CREATED";
    expect(await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps)).toMatchObject({ kind: "started" });
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settling", settlement_status: "running" });
  });

  it("stores the checks it ran, the totals and who started it", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      real: [{ number: 142, holdCents: 50_000 }],
      simulated: [
        { number: 175, holdCents: 200_000 },
        { number: 176, holdCents: 50_000 },
      ],
      wins: [
        { number: 142, lot: 7, cents: 32_000 },
        { number: 175, lot: 1, cents: 145_000 },
      ],
    });
    const { rows: sessions } = await pool.query<{ id: string }>(
      "insert into sessions (token_hash, event_id, is_organizer) values ('x', $1, true) returning id",
      [gala.eventId],
    );
    await startSettlement({ eventId: gala.eventId, startedBySessionId: sessions[0]?.id ?? null }, deps);

    const { rows } = await pool.query(
      "select started_by_session_id, to_charge_cents, to_release_cents, winners, non_winners, checks from settlements where event_id = $1",
      [gala.eventId],
    );
    expect(rows[0]).toMatchObject({
      started_by_session_id: sessions[0]?.id,
      to_charge_cents: 177_000,
      to_release_cents: 123_000,
      winners: 2,
      non_winners: 1,
      checks: { passed: true },
    });
  });

  it("re-checks the holds under its locks: a hold that changed after the checks leaves the event closed", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, { real: [{ number: 142, holdCents: 50_000 }], wins: [{ number: 142, lot: 7, cents: 32_000 }] });
    const authorizationId = gala.holds.get(142)?.authorizationId ?? "";
    // The sweep expires the hold in the moment between PayPal's answer and the transaction.
    world.paypal.on("GET", `/v2/payments/authorizations/${authorizationId}`, async () => {
      await pool.query("update holds set status = 'expired' where id = $1", [gala.holds.get(142)?.holdId]);
      return json(200, authorizationBody(authorizationId, "CREATED", "500.00"));
    });

    const result = await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);

    expect(result.kind).toBe("checks_failed");
    if (result.kind === "checks_failed") {
      expect(result.checks.checks.find((item) => item.key === "winners_within_holds")?.problems[0]).toMatchObject({ paddleNumber: 142, code: "no_hold" });
    }
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "closed", settlement_status: null });
    expect(await itemsOf(pool, gala.eventId)).toEqual([]);
  });

  it("settles an event with no holds at all, and one with no winners", async () => {
    const { world, deps } = setup();
    const empty = await runGala(pool, world, {});
    await startSettlement({ eventId: empty.eventId, startedBySessionId: null }, deps);
    await processSettlementQueue(deps);
    expect(await eventRow(pool, empty.eventId)).toMatchObject({ status: "settled", settlement_status: "done" });

    const nobody = await runGala(pool, world, { real: [{ number: 143, holdCents: 25_000 }] });
    await startSettlement({ eventId: nobody.eventId, startedBySessionId: null }, deps);
    await processSettlementQueue(deps);
    expect(world.captures).toEqual([]);
    expect(world.voids).toHaveLength(1);
    await expect(holdRow(pool, nobody.holds.get(143)?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });
  });

  it("charges the winner the engine fixed, not who led before the last bid", async () => {
    const { world, deps } = setup();
    const gala = await runGala(pool, world, {
      live: true,
      real: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 50_000 },
      ],
      wins: [{ number: 142, lot: 7, cents: 30_000 }],
    });
    await placeBid(gala.paddles.get(143) ?? "", gala.lots.get(7) ?? "", 32_000, "guest", { pool });
    await closeEvent(gala.eventId, { pool });
    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    await processSettlementQueue(deps);
    expect(world.captures).toHaveLength(1);
    expect(world.captures[0]).toMatchObject({ authorizationId: gala.holds.get(143)?.authorizationId, amountCents: 32_000 });
    expect(world.voids.map((item) => item.authorizationId)).toEqual([gala.holds.get(142)?.authorizationId]);
  });
});
