/** The settlement routes on Postgres, in keyless mode: who may call them, and the whole charge. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as retry } from "@/app/api/events/[slug]/settlement/items/[itemId]/retry/route";
import { POST as checksRoute } from "@/app/api/events/[slug]/settlement/checks/route";
import { GET, POST } from "@/app/api/events/[slug]/settlement/route";
import { POST as webhookRoute } from "@/app/api/paypal/webhook/route";
import { createSession, sessionCookieName } from "@/server/api";
import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { closeEvent, placeBid } from "@/server/engine";
import { completeHoldApproval } from "@/server/paypal/holds";
import { paypalRequestId } from "@/server/paypal/idempotency";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import { receivePaypalWebhook } from "@/server/paypal/webhooks";
import { createSettlementTickTask, settlementRunnerIdle } from "@/server/settlement";
import type { LedgerView, SettlementChecks } from "@/server/settlement/types";
import { joinEvent } from "@/server/sessions/join";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

import { eventRow, holdRow, itemOf, receiptOf } from "./support";

const { pool, db } = getTestDatabase();

vi.mock("@/server/paypal/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/paypal/webhooks")>()),
  receivePaypalWebhook: vi.fn(),
}));

afterEach(async () => {
  vi.unstubAllEnvs();
  await settlementRunnerIdle();
});

const ORIGIN = "https://fairhold.example";
const context = (slug: string) => ({ params: Promise.resolve({ slug }) });
const read = (slug: string, cookie?: string) =>
  GET(new Request(`${ORIGIN}/api/events/${slug}/settlement`, { headers: cookie ? { cookie } : {} }), context(slug));
const start = (slug: string, cookie?: string, headers: Record<string, string> = {}) =>
  POST(postJson(`/api/events/${slug}/settlement`, {}, { ...(cookie ? { cookie } : {}), ...headers }), context(slug));
const check = (slug: string, cookie?: string) =>
  checksRoute(postJson(`/api/events/${slug}/settlement/checks`, {}, cookie ? { cookie } : {}), context(slug));
const retryItem = (slug: string, itemId: string, cookie?: string) =>
  retry(postJson(`/api/events/${slug}/settlement/items/${itemId}/retry`, {}, cookie ? { cookie } : {}), {
    params: Promise.resolve({ slug, itemId }),
  });

/** A demo with its creator's organizer session, and a guest with a session of their own. */
async function demo() {
  const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
  const organizer = await createSession(
    { eventId: event.id, paddleId: creator.paddleId, isOrganizer: true, organizerName: creator.firstName },
    pool,
  );
  const joined = await joinEvent({ slug: event.slug, firstName: "Kai", session: null }, pool);
  if (!joined.created) throw new Error("The guest did not get a session");
  return {
    event,
    creator,
    guestPaddleId: joined.created.session.paddleId ?? "",
    organizerCookie: `${sessionCookieName(event.slug)}=${organizer.token}`,
    guestCookie: `${sessionCookieName(event.slug)}=${joined.created.token}`,
  };
}

/** A real hold in keyless mode: the simulated PayPal, approved through the return page's own code. */
async function approvedHold(eventId: string, paddleId: string, amountCents: number) {
  const { rows } = await pool.query<{ id: string }>(
    "insert into holds (event_id, paddle_id, kind, amount_cents) values ($1, $2, 'paypal', $3) returning id",
    [eventId, paddleId, amountCents],
  );
  const holdId = rows[0]?.id ?? "";
  const order = await getSimulatedPayments().createAuthorizeOrder({
    holdId,
    amountCents,
    description: "Bidding power",
    softDescriptor: "RIVERSIDEGALA",
    returnUrl: `${ORIGIN}/paypal/return?hold=${holdId}`,
    cancelUrl: `${ORIGIN}/paypal/cancel?hold=${holdId}`,
    idempotencyKey: paypalRequestId("create-order", holdId),
  });
  await pool.query("update holds set paypal_order_id = $2 where id = $1", [holdId, order.orderId]);
  await completeHoldApproval({ holdId, orderId: order.orderId });
  return holdId;
}

describe("who may use the control room", () => {
  it("answers 401 with no session and 403 to a guest, on every route", async () => {
    const { event, guestCookie } = await demo();
    const someItem = "00000000-0000-4000-8000-000000000000";

    for (const response of [await read(event.slug), await start(event.slug), await check(event.slug), await retryItem(event.slug, someItem)]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "not_joined" } });
    }
    for (const response of [
      await read(event.slug, guestCookie),
      await start(event.slug, guestCookie),
      await check(event.slug, guestCookie),
      await retryItem(event.slug, someItem, guestCookie),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "organizer_only" } });
    }
  });

  it("does not let one event's organizer into another event", async () => {
    const first = await demo();
    const second = await demo();
    const stolen = `${sessionCookieName(second.event.slug)}=${first.organizerCookie.split("=")[1]}`;
    expect((await read(second.event.slug, stolen)).status).toBe(401);
  });

  it("refuses a cross-site POST", async () => {
    const { event, organizerCookie } = await demo();
    const response = await POST(
      new Request(`${ORIGIN}/api/events/${event.slug}/settlement`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example", cookie: organizerCookie },
        body: "{}",
      }),
      context(event.slug),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross_origin" } });
  });

  it("opens the seeded fixture without a session outside production, and never in production", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const open = await read(FIXTURE_SLUG);
    expect(open.status).toBe(200);
    expect(((await open.json()) as LedgerView).counts.all).toBe(86);

    vi.stubEnv("NODE_ENV", "production");
    expect((await read(FIXTURE_SLUG)).status).toBe(401);
    expect((await start(FIXTURE_SLUG)).status).toBe(401);
  });

  it("answers 404 for an item of another event, or not an id at all", async () => {
    const { event, organizerCookie } = await demo();
    expect((await retryItem(event.slug, "not-a-uuid", organizerCookie)).status).toBe(404);
    const missing = await retryItem(event.slug, "00000000-0000-4000-8000-000000000000", organizerCookie);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: { code: "item_not_found" } });
  });
});

describe("charging through the routes", () => {
  it("refuses while bidding runs", async () => {
    const { event, organizerCookie } = await demo();
    const live = await read(event.slug, organizerCookie);
    expect(((await live.json()) as LedgerView).phase).toBe("live");

    const started = await start(event.slug, organizerCookie);
    expect(started.status).toBe(409);
    expect(await started.json()).toMatchObject({ error: { code: "bidding_open" } });
    expect((await check(event.slug, organizerCookie)).status).toBe(409);
  });

  it("runs a demo from close to settled: a real capture and a real void beside simulated guests", async () => {
    const { event, creator, guestPaddleId, organizerCookie } = await demo();
    const samHold = await approvedHold(event.id, creator.paddleId, 50_000);
    const kaiHold = await approvedHold(event.id, guestPaddleId, 25_000);
    const { rows: lots } = await pool.query<{ id: string; starting: number }>(
      "select id, starting_bid_cents as starting from lots where event_id = $1 and number = 24",
      [event.id],
    );
    const lot = lots[0];
    const { rows: minimum } = await pool.query<{ next: number }>(
      "select coalesce(current_bid_cents + min_raise_cents, starting_bid_cents) as next from lots where id = $1",
      [lot?.id],
    );
    expect(await placeBid(creator.paddleId, lot?.id ?? "", minimum[0]?.next ?? 0, "guest", { pool })).toMatchObject({ ok: true });
    await closeEvent(event.id, { pool });

    const before = (await (await read(event.slug, organizerCookie)).json()) as LedgerView;
    expect(before.phase).toBe("ready");
    expect(before.holds.real).toBe(2);
    expect(before.checks.passed).toBeNull();

    const checked = await check(event.slug, organizerCookie);
    expect(checked.status).toBe(200);
    const { checks } = (await checked.json()) as { checks: SettlementChecks };
    expect(checks.passed).toBe(true);
    expect(checks.checks.find((item) => item.key === "holds_valid")).toMatchObject({ passed: true, count: 2 });

    const started = await start(event.slug, organizerCookie);
    expect(started.status).toBe(200);
    expect(((await started.json()) as LedgerView).settlement).not.toBeNull();
    // A double click.
    expect((await start(event.slug, organizerCookie)).status).toBe(200);
    await settlementRunnerIdle();

    const after = (await (await read(event.slug, organizerCookie)).json()) as LedgerView;
    expect(after.phase).toBe("charged");
    expect(after.settlement).toMatchObject({ status: "done", failed: 0, active: 0 });
    await expect(holdRow(pool, samHold)).resolves.toMatchObject({ status: "captured" });
    await expect(holdRow(pool, kaiHold)).resolves.toMatchObject({ status: "voided" });
    const sam = await itemOf(pool, event.id, 142);
    expect(sam.action).toBe("capture");
    expect(sam.paypal_capture_id).toMatch(/^SIMC/);
    expect((await receiptOf(pool, event.id, creator.paddleId))[0]).toMatchObject({ paypal_capture_id: sam.paypal_capture_id, paid_cents: minimum[0]?.next });
    expect(await eventRow(pool, event.id)).toMatchObject({ status: "settled" });

    const { rows: started2 } = await pool.query<{ started_by_session_id: string | null }>(
      "select started_by_session_id from settlements where event_id = $1",
      [event.id],
    );
    expect(started2[0]?.started_by_session_id).not.toBeNull();
  });

  it("answers 409 with the checks when one fails, and retries a failed row", async () => {
    const { event, creator, organizerCookie } = await demo();
    const holdId = await approvedHold(event.id, creator.paddleId, 50_000);
    const { rows: lots } = await pool.query<{ id: string; next: number }>(
      "select id, coalesce(current_bid_cents + min_raise_cents, starting_bid_cents) as next from lots where event_id = $1 and number = 24",
      [event.id],
    );
    await placeBid(creator.paddleId, lots[0]?.id ?? "", lots[0]?.next ?? 0, "guest", { pool });
    await closeEvent(event.id, { pool });

    await pool.query("update holds set status = 'expired' where id = $1", [holdId]);
    const refused = await start(event.slug, organizerCookie);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: { code: string; details: { checks: SettlementChecks } } };
    expect(body.error.code).toBe("checks_failed");
    expect(body.error.details.checks.passed).toBe(false);

    await pool.query("update holds set status = 'authorized' where id = $1", [holdId]);
    expect((await start(event.slug, organizerCookie)).status).toBe(200);
    await settlementRunnerIdle();
    await expect(holdRow(pool, holdId)).resolves.toMatchObject({ status: "captured" });

    // Nothing left to retry: a late click answers the ledger and changes nothing.
    const item = await itemOf(pool, event.id, 142);
    const late = await retryItem(event.slug, item.id, organizerCookie);
    expect(late.status).toBe(200);
    expect((await itemOf(pool, event.id, 142)).status).toBe("succeeded");
  });

  it("limits how often a guest of the page can make it ask PayPal", async () => {
    const { event, organizerCookie } = await demo();
    await closeEvent(event.id, { pool });
    // The limit is a fixed window on the minute, and all 31 calls must land in one of them.
    const secondsIntoMinute = (Date.now() % 60_000) / 1_000;
    if (secondsIntoMinute > 45) await new Promise((resolve) => setTimeout(resolve, (60 - secondsIntoMinute) * 1_000));
    const statuses: number[] = [];
    for (let calls = 0; calls < 31; calls += 1) statuses.push((await check(event.slug, organizerCookie)).status);
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe("the tick", () => {
  it("brings a queued settlement forward with nothing else kicking it", async () => {
    const { event, organizerCookie } = await demo();
    await closeEvent(event.id, { pool });
    await start(event.slug, organizerCookie);
    await settlementRunnerIdle();
    // Back to a state as if the process had died right after the start.
    await pool.query(
      `update settlement_items i set status = 'queued', next_attempt_at = null, completed_at = null
       from settlements s where s.id = i.settlement_id and s.event_id = $1`,
      [event.id],
    );
    await pool.query("update settlements set status = 'running', finished_at = null where event_id = $1", [event.id]);
    await pool.query("update events set status = 'settling', settled_at = null where id = $1", [event.id]);

    await createSettlementTickTask().run();
    await settlementRunnerIdle();

    expect(await eventRow(pool, event.id)).toMatchObject({ status: "settled", settlement_status: "done" });
  });
});

describe("POST /api/paypal/webhook", () => {
  it("answers 200 once stored, and applies the event without PayPal waiting for it", async () => {
    const store = createPostgresWebhookEventStore(db);
    const event = { eventId: "WH-ROUTE", eventType: "BILLING.OTHER", resourceType: null, resourceId: null, payload: { id: "WH-ROUTE" } };
    vi.mocked(receivePaypalWebhook).mockImplementation(async () => {
      const result = await store.insertOnce(event);
      return { kind: result, eventId: event.eventId, eventType: event.eventType };
    });
    const delivery = () =>
      new Request(`${ORIGIN}/api/paypal/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "paypal-transmission-id": "t" },
        body: "{}",
      });

    const response = await webhookRoute(delivery());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, result: "stored" });
    await settlementRunnerIdle();
    const { rows } = await pool.query<{ processed_at: Date | null }>(
      "select processed_at from paypal_webhook_events where paypal_event_id = 'WH-ROUTE'",
    );
    expect(rows[0]?.processed_at).toBeInstanceOf(Date);

    expect(await (await webhookRoute(delivery())).json()).toEqual({ ok: true, result: "duplicate" });
  });
});
