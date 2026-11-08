/**
 * createHold on Postgres: a window opens only when approving it could become the bidding power, the
 * order carries what PayPal needs, and every refusal leaves nothing behind.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHold, type CreateHoldDependencies } from "@/server/holds/create";
import { PaypalError } from "@/server/paypal/errors";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { CreateAuthorizeOrderRequest, HoldKind, Payments } from "@/server/paypal/payments";
import { createSimulatedPaypalState, SimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold as insertAuthorizedHold, createLot, createPaddle } from "../engine/support/fixtures";

const { pool, db } = getTestDatabase();

const ORIGIN = "https://fairhold.example";

interface Harness {
  dependencies: CreateHoldDependencies;
  orders: CreateAuthorizeOrderRequest[];
  payments: SimulatedPayments;
  kinds: HoldKind[];
}

function harness(overrides: Partial<Payments> = {}): Harness {
  const payments = new SimulatedPayments(createSimulatedPaypalState());
  const orders: CreateAuthorizeOrderRequest[] = [];
  const kinds: HoldKind[] = [];
  const spy: Payments = {
    mode: "simulated",
    createAuthorizeOrder: (request) => {
      orders.push(request);
      return overrides.createAuthorizeOrder ? overrides.createAuthorizeOrder(request) : payments.createAuthorizeOrder(request);
    },
    authorizeOrder: (request) => payments.authorizeOrder(request),
    getAuthorization: (id) => payments.getAuthorization(id),
    capture: (request) => payments.capture(request),
    void: (request) => payments.void(request),
    reauthorize: (request) => payments.reauthorize(request),
  };
  return {
    orders,
    payments,
    kinds,
    dependencies: {
      pool,
      store: createPostgresHoldStore(db),
      sleep: async () => {},
      paymentsFor: (kind) => {
        kinds.push(kind);
        return spy;
      },
    },
  };
}

async function gala(options: { status?: string; min?: number; max?: number; descriptor?: string } = {}) {
  const eventId = await createEvent(pool, options.status ?? "live");
  await pool.query(
    "update events set hold_min_cents = $2, hold_max_cents = $3, soft_descriptor = $4 where id = $1",
    [eventId, options.min ?? 25_00, options.max ?? 1_000_00, options.descriptor ?? "RIVERSIDEGALA"],
  );
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
  const paddleId = await createPaddle(pool, eventId, 142);
  // A real guest's: the simulated paddles from the shared fixtures settle in simulation.
  await pool.query("update paddles set is_simulated = false where id = $1", [paddleId]);
  return { eventId, slug: rows[0]?.slug ?? "", paddleId };
}

async function holdRows(paddleId: string) {
  const { rows } = await pool.query<{ id: string; status: string; kind: string; amount: number; order: string | null; debug: string | null }>(
    `select id, status, kind, amount_cents as amount, paypal_order_id as order, paypal_debug_id as debug
     from holds where paddle_id = $1 and status <> 'authorized' order by created_at, id`,
    [paddleId],
  );
  return rows;
}

async function holdLogRows(paddleId: string) {
  const { rows } = await pool.query<{ payload: unknown }>(
    "select payload from event_log where paddle_id = $1 and type = 'hold' order by id",
    [paddleId],
  );
  return rows.map((row) => row.payload);
}

describe("createHold in production", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("opens no window on a seeded event, whatever session got this far", async () => {
    const { paddleId } = await gala();
    const { dependencies, orders } = harness();
    vi.stubEnv("NODE_ENV", "production");

    await expect(createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies)).rejects.toMatchObject({
      status: 403,
      code: "event_view_only",
    });
    expect(orders).toEqual([]);
    expect(await holdRows(paddleId)).toEqual([]);
  });

  it("opens one on a demo gala", async () => {
    const { eventId, paddleId } = await gala();
    await pool.query("update events set is_demo = true where id = $1", [eventId]);
    const { dependencies } = harness();
    vi.stubEnv("NODE_ENV", "production");

    await expect(createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies)).resolves.toMatchObject({ amountCents: 500_00 });
  });
});

describe("createHold", () => {
  it("inserts a pending hold, creates its order, stores the order id and returns PayPal's link", async () => {
    const { slug, paddleId } = await gala();
    const { dependencies, orders, kinds } = harness();

    const created = await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN, next: `/e/${slug}/lots/07` }, dependencies);

    const [row] = await holdRows(paddleId);
    expect(row).toMatchObject({ id: created.holdId, status: "pending_approval", kind: "paypal", amount: 500_00 });
    expect(row?.order).toMatch(/^SIMO/);
    expect(row?.debug).toMatch(/^sim-/);
    expect(created.amountCents).toBe(500_00);
    // Simulated approval is instant: the link is the return page itself, with PayPal's own additions.
    const link = new URL(created.approvalUrl);
    expect(`${link.origin}${link.pathname}`).toBe(`${ORIGIN}/paypal/return`);
    expect(link.searchParams.get("hold")).toBe(created.holdId);
    expect(link.searchParams.get("token")).toBe(row?.order);
    expect(kinds).toEqual(["paypal"]);

    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order).toMatchObject({
      holdId: created.holdId,
      amountCents: 500_00,
      softDescriptor: "RIVERSIDEGALA",
      idempotencyKey: paypalRequestId("create-order", created.holdId),
      description: "Bidding power hold for Riverside Shelter Gala",
    });
    const returnUrl = new URL(order?.returnUrl ?? "");
    const cancelUrl = new URL(order?.cancelUrl ?? "");
    expect(returnUrl.pathname).toBe("/paypal/return");
    expect(cancelUrl.pathname).toBe("/paypal/cancel");
    for (const url of [returnUrl, cancelUrl]) {
      expect(url.origin).toBe(ORIGIN);
      expect(url.searchParams.get("hold")).toBe(created.holdId);
      expect(url.searchParams.get("next")).toBe(`/e/${slug}/lots/07`);
    }
  });

  it("tells the paddle's channel, with no amount for the raise trigger to read", async () => {
    const { paddleId } = await gala();
    const { holdId } = await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, harness().dependencies);
    expect(await holdLogRows(paddleId)).toEqual([{ holdId, status: "pending_approval" }]);
  });

  it("accepts a next only from this event", async () => {
    const { slug, paddleId } = await gala();
    for (const next of ["https://evil.example/", "//evil.example", "/e/another-gala/lots/7", null, undefined]) {
      const { dependencies, orders } = harness();
      await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN, next }, dependencies);
      expect(new URL(orders[0]?.returnUrl ?? "").searchParams.get("next")).toBe(`/e/${slug}`);
    }
  });

  it("settles a simulated paddle in simulation, whatever the mode", async () => {
    const { eventId } = await gala();
    const bot = await createPaddle(pool, eventId, 88);
    const { dependencies, kinds } = harness();

    await createHold({ paddleId: bot, amountCents: 500_00, origin: ORIGIN }, dependencies);

    expect(kinds).toEqual(["simulated"]);
    expect((await holdRows(bot))[0]).toMatchObject({ kind: "simulated" });
  });

  it("makes a statement text from the name when the event has none", async () => {
    const { eventId, paddleId } = await gala();
    await pool.query("update events set soft_descriptor = null where id = $1", [eventId]);
    const { dependencies, orders } = harness();

    await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies);

    expect(orders[0]?.softDescriptor).toBe("RIVERSIDESHELTERGALA");
  });

  it("leaves the hold in place until PayPal approves the raise", async () => {
    const { eventId, paddleId } = await gala();
    await insertAuthorizedHold(pool, eventId, paddleId, 500_00);

    await createHold({ paddleId, amountCents: 750_00, origin: ORIGIN }, harness().dependencies);

    const { rows } = await pool.query<{ amount: number }>(
      "select amount_cents as amount from holds where paddle_id = $1 and status = 'authorized'",
      [paddleId],
    );
    expect(rows).toEqual([{ amount: 500_00 }]);
  });

  describe("refuses, calling PayPal never and leaving nothing behind", () => {
    async function expectRefusal(paddleId: string, amountCents: number, expected: { status: number; code: string; details?: unknown; message?: string }) {
      const { dependencies, orders } = harness();
      const before = (await holdLogRows(paddleId)).length;
      await expect(createHold({ paddleId, amountCents, origin: ORIGIN }, dependencies)).rejects.toMatchObject(expected);
      expect(orders).toEqual([]);
      expect(await holdRows(paddleId)).toEqual([]);
      expect(await holdLogRows(paddleId)).toHaveLength(before);
    }

    it("an amount with cents", async () => {
      const { paddleId } = await gala();
      await expectRefusal(paddleId, 500_50, { status: 400, code: "amount_not_whole_dollars" });
    });

    it("an amount under the event's minimum", async () => {
      const { paddleId } = await gala();
      await expectRefusal(paddleId, 24_00, {
        status: 400,
        code: "amount_below_minimum",
        details: { minCents: 25_00 },
        message: "The least you can hold is $25.",
      });
    });

    it("an amount over the event's maximum", async () => {
      const { paddleId } = await gala();
      await expectRefusal(paddleId, 1_001_00, {
        status: 400,
        code: "amount_above_maximum",
        details: { maxCents: 1_000_00 },
        message: "The most you can hold is $1,000.",
      });
    });

    it("a raise that is not above the hold in place, the same amount included", async () => {
      const { eventId, paddleId } = await gala();
      await insertAuthorizedHold(pool, eventId, paddleId, 500_00);
      const expected = {
        status: 409,
        code: "not_a_raise",
        details: { currentHoldCents: 500_00 },
        message: "You already hold $500. Choose more than that.",
      };
      await expectRefusal(paddleId, 500_00, expected);
      await expectRefusal(paddleId, 250_00, expected);
    });

    it("a hold too small for what the paddle has already committed", async () => {
      const { eventId, paddleId } = await gala();
      const chefsTable = await createLot(pool, eventId, { number: 7, startingBidCents: 100_00, minRaiseCents: 20_00 });
      // A standing bid with no hold in place: the paddle's old hold expired under it.
      await pool.query("update lots set high_paddle_id = $2, current_bid_cents = 320_00, bid_count = 1 where id = $1", [chefsTable, paddleId]);
      await expectRefusal(paddleId, 250_00, {
        status: 409,
        code: "below_commitments",
        details: { committedCents: 320_00 },
        message: "Your bids already need $320 of bidding power. Choose at least that.",
      });

      const created = await createHold({ paddleId, amountCents: 320_00, origin: ORIGIN }, harness().dependencies);
      expect(created.amountCents).toBe(320_00);
    });

    it("anything once bidding has ended, by status", async () => {
      for (const status of ["closed", "settling", "settled"]) {
        const { paddleId } = await gala({ status });
        await expectRefusal(paddleId, 500_00, { status: 409, code: "bidding_ended", message: "Bidding has closed for this event." });
      }
    });

    it("anything once the event's close has passed, before the tick has closed it", async () => {
      const { eventId, paddleId } = await gala();
      await pool.query("update events set closes_at = now() - interval '1 second' where id = $1", [eventId]);
      await expectRefusal(paddleId, 500_00, { status: 409, code: "bidding_ended" });
    });

    it("a paddle that does not exist", async () => {
      const { dependencies, orders } = harness();
      await expect(
        createHold({ paddleId: "00000000-0000-4000-8000-000000000000", amountCents: 500_00, origin: ORIGIN }, dependencies),
      ).rejects.toMatchObject({ status: 404, code: "paddle_not_found" });
      expect(orders).toEqual([]);
    });
  });

  it("agrees with the swap: a window it opens is one the approval accepts", async () => {
    const { eventId, paddleId } = await gala();
    await insertAuthorizedHold(pool, eventId, paddleId, 500_00);
    const { dependencies, payments } = harness();

    const created = await createHold({ paddleId, amountCents: 501_00, origin: ORIGIN }, dependencies);

    const { completeHoldApproval } = await import("@/server/paypal/holds");
    const orderId = new URL(created.approvalUrl).searchParams.get("token");
    const outcome = await completeHoldApproval(
      { holdId: created.holdId, orderId },
      { store: createPostgresHoldStore(db), paymentsFor: () => payments, now: () => new Date(), sleep: async () => {} },
    );
    expect(outcome).toMatchObject({ kind: "authorized", hold: { amountCents: 501_00 } });
  });

  describe("when PayPal fails", () => {
    const failure = (code: string, httpStatus: number) =>
      new PaypalError({ operation: "createAuthorizeOrder", code, httpStatus, debugId: "debug-1" });

    it("marks the hold failed, keeps the debug id and says nothing was held", async () => {
      const { paddleId } = await gala();
      const create = vi.fn(() => Promise.reject(failure("PERMISSION_DENIED", 403)));
      const { dependencies, orders } = harness({ createAuthorizeOrder: create });
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies)).rejects.toMatchObject({
        status: 502,
        code: "paypal_unavailable",
        message: "PayPal could not start this hold. Nothing was held. Please try again.",
      });

      errorLog.mockRestore();
      expect(orders).toHaveLength(1);
      expect(await holdRows(paddleId)).toMatchObject([{ status: "failed", order: null, debug: "debug-1" }]);
      expect(await holdLogRows(paddleId)).toMatchObject([
        { status: "pending_approval" },
        { status: "failed", code: "PERMISSION_DENIED" },
      ]);
    });

    it("retries a transient failure with the same request id", async () => {
      const { paddleId } = await gala();
      const real = new SimulatedPayments(createSimulatedPaypalState());
      let calls = 0;
      const { dependencies, orders } = harness({
        createAuthorizeOrder: (request) => {
          calls += 1;
          return calls < 3 ? Promise.reject(failure("INTERNAL_SERVER_ERROR", 500)) : real.createAuthorizeOrder(request);
        },
      });

      const created = await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies);

      expect(orders).toHaveLength(3);
      expect(new Set(orders.map((order) => order.idempotencyKey))).toEqual(new Set([paypalRequestId("create-order", created.holdId)]));
      expect((await holdRows(paddleId))[0]).toMatchObject({ status: "pending_approval" });
    });

    it("gives up after three attempts, and at once on a timeout, which has kept the guest waiting already", async () => {
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

      const down = await gala();
      const stillDown = harness({ createAuthorizeOrder: () => Promise.reject(failure("INTERNAL_SERVER_ERROR", 500)) });
      await expect(createHold({ paddleId: down.paddleId, amountCents: 500_00, origin: ORIGIN }, stillDown.dependencies)).rejects.toMatchObject({
        code: "paypal_unavailable",
      });
      expect(stillDown.orders).toHaveLength(3);

      const slow = await gala();
      const timedOut = harness({ createAuthorizeOrder: () => Promise.reject(failure("TIMEOUT", 504)) });
      await expect(createHold({ paddleId: slow.paddleId, amountCents: 500_00, origin: ORIGIN }, timedOut.dependencies)).rejects.toMatchObject({
        code: "paypal_unavailable",
      });
      expect(timedOut.orders).toHaveLength(1);

      errorLog.mockRestore();
    });

    it("marks the hold failed on an unexpected error too, and lets it surface", async () => {
      const { paddleId } = await gala();
      const bug = new RangeError("softDescriptor must be 1-22 characters");
      const { dependencies } = harness({ createAuthorizeOrder: () => Promise.reject(bug) });

      await expect(createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies)).rejects.toBe(bug);

      expect((await holdRows(paddleId))[0]).toMatchObject({ status: "failed" });
    });
  });

  describe("the window limit", () => {
    it("stops a looping client, and does not count a request it refused", async () => {
      const { paddleId } = await gala();
      const { dependencies, orders } = harness();

      const key = `hold:${paddleId}`;
      const counted = async () =>
        (await pool.query<{ total: number }>("select coalesce(sum(count), 0)::int as total from rate_limits where key = $1", [key]))
          .rows[0]?.total;

      await expect(createHold({ paddleId, amountCents: 24_00, origin: ORIGIN }, dependencies)).rejects.toMatchObject({
        code: "amount_below_minimum",
      });
      expect(await counted()).toBe(0);

      await createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies);
      expect(await counted()).toBe(1);
      expect(orders).toHaveLength(1);

      // This 10-minute window and the next are both full, so the test cannot straddle their boundary.
      await pool.query(
        `insert into rate_limits (key, window_start, count)
         select $1, to_timestamp((floor(extract(epoch from now()) / 600) + n) * 600), 20 from generate_series(0, 1) n
         on conflict (key, window_start) do update set count = 20`,
        [key],
      );
      await expect(createHold({ paddleId, amountCents: 500_00, origin: ORIGIN }, dependencies)).rejects.toMatchObject({
        status: 429,
        code: "rate_limited",
      });
      expect(orders).toHaveLength(1);
    });
  });

  it("waits for a transaction holding the paddle row, then reads what it committed", async () => {
    const { eventId, paddleId } = await gala();
    await insertAuthorizedHold(pool, eventId, paddleId, 500_00);

    // A raise swapping the hold, under the lock every writer of a paddle's hold takes first.
    const swap = await pool.connect();
    await swap.query("begin");
    await swap.query("select id from paddles where id = $1 for no key update", [paddleId]);
    await swap.query("update holds set status = 'replaced' where paddle_id = $1 and status = 'authorized'", [paddleId]);
    await insertAuthorizedHold(swap, eventId, paddleId, 800_00);

    const waiting = createHold({ paddleId, amountCents: 750_00, origin: ORIGIN }, harness().dependencies);
    await untilWaitingOnLocks(1);
    await swap.query("commit");
    swap.release();

    await expect(waiting).rejects.toMatchObject({ code: "not_a_raise", details: { currentHoldCents: 800_00 } });
  });
});

async function untilWaitingOnLocks(count: number): Promise<void> {
  for (let tries = 0; tries < 300; tries += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} backends started waiting on a lock`);
}
