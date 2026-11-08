/** The demo control routes: organizer only, demo only, and what each control does on Postgres. */
import { beforeEach, describe, expect, it } from "vitest";

import { POST } from "@/app/api/events/[slug]/demo/[action]/route";
import { POST as startDemo } from "@/app/api/demo/route";
import { POST as join } from "@/app/api/events/[slug]/join/route";
import {
  clientRateLimitKey,
  createSession,
  getSession,
  requireOrganizer,
  requirePaddle,
  sessionCookieName,
  takeRateLimit,
  type ApiError,
} from "@/server/api";
import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { DEMO_LENGTH_MS } from "@/server/demo/schedule";
import { DEMO_LIMITS } from "@/server/demo/start";
import { requireDemoEvent, resetDemo } from "@/server/director/controls";
import { runSweep } from "@/server/director/sweep";
import { placeBid } from "@/server/engine";
import { PaypalError } from "@/server/paypal/errors";
import type { Payments } from "@/server/paypal/payments";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";

import { getTestDatabase } from "../../helpers/database";
import { postJson, withCookie } from "../api/support";
import { createEvent, createPaddle } from "../engine/support/fixtures";

import { approveRealHold, jobsOf, lotRow, rows } from "./support";

const { pool } = getTestDatabase();

beforeEach(async () => {
  await pool.query("delete from events; delete from rate_limits");
});

const control = (slug: string, action: string, headers: Record<string, string> = {}) =>
  POST(postJson(`/api/events/${slug}/demo/${action}`, {}, headers), { params: Promise.resolve({ slug, action }) });

const ACTIONS = ["close-next-lot", "close-bidding", "add-time", "invite", "reset"] as const;

interface Started {
  slug: string;
  paddleNumber: number;
  firstName: string;
  href: string;
}

const cookiesFrom = (response: Response): string[] => response.headers.getSetCookie();

/** The name=value of the cookie for `slug` on a response. */
function cookieFor(response: Response, slug: string): string {
  const prefix = `${sessionCookieName(slug)}=`;
  const found = cookiesFrom(response).find((cookie) => cookie.startsWith(prefix));
  if (!found) throw new Error(`no cookie for ${slug}`);
  return found.split(";")[0] ?? "";
}

interface Gala {
  slug: string;
  eventId: string;
  /** The organizer's session cookie. */
  cookie: string;
  paddleId: string;
  lot(number: number): Promise<string>;
}

async function gala(firstName = "Sam"): Promise<Gala> {
  const response = await startDemo(postJson("/api/demo", { firstName, timeZone: "America/Chicago" }), undefined);
  const { slug } = (await response.json()) as Started;
  const [event] = await rows<{ id: string }>(pool, "select id from events where slug = $1", [slug]);
  const cookie = cookieFor(response, slug);
  const session = await requirePaddle(slug, withCookie(cookie), pool);
  return {
    slug,
    eventId: event?.id ?? "",
    cookie,
    paddleId: session.paddleId,
    lot: async (number) => {
      const [lot] = await rows<{ id: string }>(pool, "select id from lots where event_id = $1 and number = $2", [event?.id, number]);
      return lot?.id ?? "";
    },
  };
}

const asOrganizer = (demo: Gala, action: string) => control(demo.slug, action, { cookie: demo.cookie });

const scheduleRows = (eventId: string) =>
  rows<{ paddle_id: string | null; type: string; payload: { kind: string; closesAt: number | null; lots: { lotId: string; lotNumber: number; closesAt: number }[] } }>(
    pool,
    "select paddle_id, type, payload from event_log where event_id = $1 and payload->>'kind' = 'schedule_changed' order by id",
    [eventId],
  );

describe("who may use the demo controls", () => {
  it("refuses a browser with no session, and changes nothing", async () => {
    const demo = await gala();
    for (const action of ACTIONS) {
      const response = await control(demo.slug, action);
      expect(response.status, action).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "not_joined" } });
    }
    expect((await lotRow(pool, await demo.lot(3))).status).toBe("open");
  });

  it("refuses a guest who joined, and changes nothing", async () => {
    const demo = await gala();
    const joined = await join(postJson(`/api/events/${demo.slug}/join`, { firstName: "Kai" }), { params: Promise.resolve({ slug: demo.slug }) });
    const cookie = cookieFor(joined, demo.slug);
    const before = await rows(pool, "select id, closes_at, status from lots where event_id = $1 order by id", [demo.eventId]);
    for (const action of ACTIONS) {
      const response = await control(demo.slug, action, { cookie });
      expect(response.status, action).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "organizer_only" } });
    }
    expect(await rows(pool, "select id, closes_at, status from lots where event_id = $1 order by id", [demo.eventId])).toEqual(before);
    expect((await rows<{ n: number }>(pool, "select count(*)::int as n from events where is_demo"))[0]?.n).toBe(1);
  });

  it("refuses the organizer of another demo", async () => {
    const first = await gala("Sam");
    const second = await gala("Ana");
    for (const action of ACTIONS) {
      expect((await control(second.slug, action, { cookie: first.cookie })).status, action).toBe(401);
      // The other event's token under this event's cookie name is no session here either.
      const forged = first.cookie.replace(sessionCookieName(first.slug), sessionCookieName(second.slug));
      expect((await control(second.slug, action, { cookie: forged })).status, action).toBe(401);
    }
    expect((await lotRow(pool, await second.lot(3))).status).toBe("open");
  });

  it("refuses another site, even with the organizer's cookie", async () => {
    const demo = await gala();
    const response = await control(demo.slug, "close-bidding", { cookie: demo.cookie, origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross_origin" } });
    expect((await lotRow(pool, await demo.lot(3))).status).toBe("open");
  });

  it("works only on a demo gala", async () => {
    const eventId = await createEvent(pool);
    const paddle = await createPaddle(pool, eventId, 101);
    const created = await createSession({ eventId, paddleId: paddle, isOrganizer: true }, pool);
    const cookie = `${sessionCookieName(created.session.eventSlug)}=${created.token}`;
    for (const action of ACTIONS) {
      const response = await control(created.session.eventSlug, action, { cookie });
      expect(response.status, action).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "demo_only" } });
    }
  });

  it("does not reach the approved fixture", async () => {
    const { event } = await createFixtureEvent({}, pool);
    expect(await jobsOf(pool, event.id)).toEqual([]);
    const created = await createSession({ eventId: event.id, paddleId: null, isOrganizer: true }, pool);
    const cookie = `${sessionCookieName(event.slug)}=${created.token}`;
    expect((await control(event.slug, "reset", { cookie })).status).toBe(403);
  });

  it("answers 404 for a control that does not exist", async () => {
    const demo = await gala();
    const response = await asOrganizer(demo, "self-destruct");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "unknown_control" } });
  });
});

describe("close-next-lot", () => {
  it("closes the lot nearest its end, fixes its winner, and refuses bids after it", async () => {
    const demo = await gala();
    const cabin = await demo.lot(3);
    const before = await lotRow(pool, cabin);
    const response = await asOrganizer(demo, "close-next-lot");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lotNumber: 3, shortTitle: "Cabin Stay", openLots: 23 });

    const [lot] = await rows<{ status: string; winning_paddle_id: string | null; winning_cents: number | null }>(
      pool,
      "select status, winning_paddle_id, winning_cents from lots where id = $1",
      [cabin],
    );
    expect(lot).toEqual({ status: "closed", winning_paddle_id: before.high_paddle_id, winning_cents: before.current_bid_cents });

    const [elena] = await rows<{ id: string }>(pool, "select id from paddles where event_id = $1 and number = 104", [demo.eventId]);
    const late = await placeBid(elena?.id ?? "", cabin, 70_000, "bot", { pool });
    expect(late).toMatchObject({ ok: false, refusal: { reason: "lot_closed" } });
  });

  it("tells every viewer the lot's new close time on the public channel", async () => {
    const demo = await gala();
    await asOrganizer(demo, "close-next-lot");
    const [row] = await scheduleRows(demo.eventId);
    expect(row).toMatchObject({ paddle_id: null, type: "event_status", payload: { kind: "schedule_changed", closesAt: null } });
    expect(row?.payload.lots).toEqual([{ lotId: await demo.lot(3), lotNumber: 3, closesAt: expect.any(Number) }]);
    expect(row?.payload.lots[0]?.closesAt).toBeLessThanOrEqual(Date.now());
  });

  it("goes down the schedule, and closes the event with its last lot", async () => {
    const demo = await gala();
    const closed: number[] = [];
    for (let press = 0; press < 3; press += 1) {
      const body = (await (await asOrganizer(demo, "close-next-lot")).json()) as { lotNumber: number };
      closed.push(body.lotNumber);
    }
    expect(closed).toEqual([3, 5, 9]);

    await pool.query("update lots set status = 'closed', closed_at = now() where event_id = $1 and number <> 1", [demo.eventId]);
    expect(await (await asOrganizer(demo, "close-next-lot")).json()).toMatchObject({ lotNumber: 1, openLots: 0 });
    const [event] = await rows<{ status: string }>(pool, "select status from events where id = $1", [demo.eventId]);
    expect(event?.status).toBe("closed");
    const after = await asOrganizer(demo, "close-next-lot");
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ error: { code: "event_closed" } });
  });
});

describe("close-bidding", () => {
  it("closes every lot and the event through the engine, and drops the director's plans", async () => {
    const demo = await gala();
    expect((await jobsOf(pool, demo.eventId)).length).toBeGreaterThan(0);
    const response = await asOrganizer(demo, "close-bidding");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ closedLots: 24, eventClosed: true });

    const [counts] = await rows<{ open: number; status: string }>(
      pool,
      "select (select count(*)::int from lots where event_id = e.id and status = 'open') as open, e.status from events e where e.id = $1",
      [demo.eventId],
    );
    expect(counts).toEqual({ open: 0, status: "closed" });
    expect((await jobsOf(pool, demo.eventId)).every((job) => job.status === "canceled")).toBe(true);
    const [closedRow] = await rows(pool, "select 1 from event_log where event_id = $1 and payload->>'kind' = 'event_closed'", [demo.eventId]);
    expect(closedRow).toBeDefined();
  });

  it("changes nothing when pressed again", async () => {
    const demo = await gala();
    await asOrganizer(demo, "close-bidding");
    const again = await asOrganizer(demo, "close-bidding");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ closedLots: 0, eventClosed: false });
  });
});

describe("add-time", () => {
  it("adds ten minutes to the event and to every lot still ahead of its close", async () => {
    const demo = await gala();
    const before = await rows<{ id: string; number: number; closes_at: Date }>(pool, "select id, number, closes_at from lots where event_id = $1 order by number", [demo.eventId]);
    const [eventBefore] = await rows<{ closes_at: Date }>(pool, "select closes_at from events where id = $1", [demo.eventId]);

    const response = await asOrganizer(demo, "add-time");
    expect(response.status).toBe(200);
    const added = (await response.json()) as { closesAt: string; lots: number };
    expect(added.lots).toBe(24);
    expect(new Date(added.closesAt).getTime()).toBe((eventBefore?.closes_at.getTime() ?? 0) + 600_000);

    const after = await rows<{ number: number; closes_at: Date }>(pool, "select number, closes_at from lots where event_id = $1 order by number", [demo.eventId]);
    after.forEach((lot, index) => expect(lot.closes_at.getTime()).toBe((before[index]?.closes_at.getTime() ?? 0) + 600_000));

    const [row] = await scheduleRows(demo.eventId);
    expect(row?.payload.closesAt).toBe(new Date(added.closesAt).getTime());
    expect(row?.payload.lots).toHaveLength(24);
    expect(row?.paddle_id).toBeNull();
  });

  it("never reopens a lot past its close, even one the tick has not closed yet", async () => {
    const demo = await gala();
    const cabin = await demo.lot(3);
    await pool.query("update lots set closes_at = now() - interval '1 second' where id = $1", [cabin]);
    const before = await lotRow(pool, cabin);
    const response = await asOrganizer(demo, "add-time");
    expect(((await response.json()) as { lots: number }).lots).toBe(23);
    expect((await lotRow(pool, cabin)).closes_at).toEqual(before.closes_at);
  });

  it("spreads the bids left on each lot over its new time, still before it closes", async () => {
    const demo = await gala();
    const queued = async () => {
      const jobs = await jobsOf(pool, demo.eventId, "bot_bid");
      return new Map(jobs.map((job) => [job.id, { runAt: job.run_at, lotId: String(job.payload.lotId) }]));
    };
    const before = await queued();
    await asOrganizer(demo, "add-time");
    const after = await queued();
    expect(after.size).toBe(before.size);
    const lots = await rows<{ id: string; closes_at: Date }>(pool, "select id, closes_at from lots where event_id = $1", [demo.eventId]);
    const closes = new Map(lots.map((lot) => [lot.id, lot.closes_at.getTime()]));
    for (const [id, job] of after) {
      const was = before.get(id)?.runAt.getTime() ?? 0;
      expect(job.runAt.getTime()).toBeGreaterThan(was);
      expect(job.runAt.getTime()).toBeLessThan(closes.get(job.lotId) ?? 0);
    }
    // The last of them moves to about the event's new end.
    const last = Math.max(...[...after.values()].map((job) => job.runAt.getTime()));
    const [event] = await rows<{ closes_at: Date }>(pool, "select closes_at from events where id = $1", [demo.eventId]);
    expect((event?.closes_at.getTime() ?? 0) - last).toBeLessThan(DEMO_LENGTH_MS / 5);
  });

  it("refuses once bidding has closed, and near the demo's 6-hour limit", async () => {
    const demo = await gala();
    await pool.query("update events set demo_expires_at = closes_at + interval '39 minutes' where id = $1", [demo.eventId]);
    const limited = await asOrganizer(demo, "add-time");
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({ error: { code: "demo_time_limit" } });
    expect((await scheduleRows(demo.eventId))).toEqual([]);

    await asOrganizer(demo, "close-bidding");
    const closed = await asOrganizer(demo, "add-time");
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ error: { code: "event_closed" } });
  });
});

describe("invite", () => {
  it("gives a link that opens a second real paddle, with no rights over the event", async () => {
    const demo = await gala();
    const response = await asOrganizer(demo, "invite");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      href: `/e/${demo.slug}/join`,
      url: `https://fairhold.example/e/${demo.slug}/join`,
    });

    const joined = await join(postJson(`/api/events/${demo.slug}/join`, { firstName: "Kai" }), { params: Promise.resolve({ slug: demo.slug }) });
    expect(joined.status).toBe(201);
    const session = await requirePaddle(demo.slug, withCookie(cookieFor(joined, demo.slug)), pool);
    expect(session.isOrganizer).toBe(false);
    const [paddle] = await rows<{ is_simulated: boolean }>(pool, "select is_simulated from paddles where id = $1", [session.paddleId]);
    expect(paddle?.is_simulated).toBe(false);
  });

  it("has nothing to offer once bidding has closed", async () => {
    const demo = await gala();
    await asOrganizer(demo, "close-bidding");
    const response = await asOrganizer(demo, "invite");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "event_closed" } });
  });
});

describe("reset", () => {
  it("voids the real holds, starts a new gala and moves the session there", async () => {
    const demo = await gala("Sam");
    const { holdId, authorizationId } = await approveRealHold(pool, demo.eventId, demo.paddleId, 50_000);
    const [{ id: guest } = { id: "" }] = await rows<{ id: string }>(
      pool,
      "insert into paddles (event_id, number, first_name, is_simulated) values ($1, 300, 'Kai', false) returning id",
      [demo.eventId],
    );
    const invited = await approveRealHold(pool, demo.eventId, guest, 25_000);

    const response = await asOrganizer(demo, "reset");
    expect(response.status).toBe(201);
    const body = (await response.json()) as Started;
    expect(body.slug).not.toBe(demo.slug);
    expect(body).toMatchObject({ paddleNumber: 142, firstName: "Sam", href: `/e/${body.slug}` });

    // Every real authorization is released at PayPal, with its hold updated, on the original id.
    for (const [id, authorization] of [[holdId, authorizationId], [invited.holdId, invited.authorizationId]] as const) {
      expect((await getSimulatedPayments().getAuthorization(authorization)).status).toBe("VOIDED");
      const [hold] = await rows<{ status: string }>(pool, "select status from holds where id = $1", [id]);
      expect(hold?.status).toBe("voided");
    }
    const [holdRow] = await rows<{ paddle_id: string; payload: { status: string } }>(
      pool,
      "select paddle_id, payload from event_log where type = 'hold' and payload->>'holdId' = $1 and payload->>'status' = 'voided'",
      [holdId],
    );
    expect(holdRow).toMatchObject({ paddle_id: demo.paddleId, payload: { status: "voided" } });

    // The browser is the new gala's organizer and no longer holds the old gala's session.
    const cookie = cookieFor(response, body.slug);
    await expect(requireOrganizer(body.slug, withCookie(cookie), pool)).resolves.toMatchObject({ isOrganizer: true, paddleNumber: 142 });
    const cleared = cookiesFrom(response).find((header) => header.startsWith(`${sessionCookieName(demo.slug)}=`));
    expect(cleared).toContain("Max-Age=0");

    // A clean event: the template's lots, its time zone, and a director of its own.
    const [fresh] = await rows<{ id: string; timezone: string; status: string; held: number }>(
      pool,
      `select e.id, e.timezone, e.status, (select count(*)::int from holds h join paddles pd on pd.id = h.paddle_id where h.event_id = e.id and not pd.is_simulated) as held
       from events e where e.slug = $1`,
      [body.slug],
    );
    expect(fresh).toMatchObject({ timezone: "America/Chicago", status: "live", held: 0 });
    expect((await jobsOf(pool, fresh?.id ?? "")).length).toBeGreaterThan(0);

    // The old gala is over, past its expiry so the next sweep deletes it, with nothing left to run.
    const [old] = await rows<{ status: string; expired: boolean }>(pool, "select status, demo_expires_at <= now() as expired from events where id = $1", [demo.eventId]);
    expect(old).toEqual({ status: "settled", expired: true });
    expect((await jobsOf(pool, demo.eventId)).every((job) => job.status === "canceled")).toBe(true);
    // Its session is gone with it, so the old cookie cannot press anything again.
    await expect(getSession(demo.slug, withCookie(demo.cookie), pool)).resolves.toBeNull();
    expect((await asOrganizer(demo, "reset")).status).toBe(401);
  });

  it("lets one of several presses through, however they interleave", async () => {
    const demo = await gala();
    const session = await requirePaddle(demo.slug, withCookie(demo.cookie), pool);
    const event = await requireDemoEvent(demo.slug, pool);

    const presses = await Promise.allSettled(Array.from({ length: 4 }, () => resetDemo({ event, session, dependencies: { pool } })));

    expect(presses.filter((press) => press.status === "fulfilled")).toHaveLength(1);
    const refused = presses.flatMap((press) => (press.status === "rejected" ? [press.reason as ApiError] : []));
    expect(refused.map((error) => [error.status, error.code])).toEqual(Array.from({ length: 3 }, () => [409, "demo_already_reset"]));
    const [running] = await rows<{ n: number }>(pool, "select count(*)::int as n from events where is_demo and status = 'live' and closes_at > now()");
    expect(running?.n).toBe(1);
  });

  it("refuses a press that began before the winning one and reached the lock after it", async () => {
    const demo = await gala();
    const session = await requirePaddle(demo.slug, withCookie(demo.cookie), pool);
    const event = await requireDemoEvent(demo.slug, pool);
    let letGo = () => {};
    const gate = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let reachedGate = () => {};
    const reached = new Promise<void>((resolve) => {
      reachedGate = resolve;
    });
    // This press's transaction has begun, and it stops just before it asks for the start lock.
    const heldBack = async () => {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (...args: Parameters<typeof target.query>) => {
              if (String(args[0]).includes("pg_advisory_xact_lock")) {
                reachedGate();
                await gate;
              }
              return (target.query as (...all: unknown[]) => unknown)(...args);
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value as (...all: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const heldPool = new Proxy(pool, {
      get(target, property) {
        if (property === "connect") return heldBack;
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...all: unknown[]) => unknown).bind(target) : value;
      },
    });

    const late = resetDemo({ event, session, dependencies: { pool: heldPool } });
    await reached;
    await resetDemo({ event, session, dependencies: { pool } });
    letGo();

    await expect(late).rejects.toMatchObject({ status: 409, code: "demo_already_reset" });
  });

  it("keeps an invited guest's session, so they can still see the gala closed", async () => {
    const demo = await gala();
    const joined = await join(postJson(`/api/events/${demo.slug}/join`, { firstName: "Kai" }), { params: Promise.resolve({ slug: demo.slug }) });
    const guest = cookieFor(joined, demo.slug);

    expect((await asOrganizer(demo, "reset")).status).toBe(201);

    await expect(getSession(demo.slug, withCookie(guest), pool)).resolves.toMatchObject({ isOrganizer: false, firstName: "Kai" });
  });

  it("starts over from a gala that finished charging", async () => {
    const demo = await gala();
    await pool.query("update events set status = 'settled', settled_at = now() where id = $1", [demo.eventId]);

    expect((await asOrganizer(demo, "reset")).status).toBe(201);
  });

  describe("with every demo slot taken", () => {
    const fillSlots = (count: number) =>
      pool.query(
        `insert into events (slug, name, charity_name, closes_at, status, is_demo)
         select 'full-' || n, 'Other gala', 'Other charity', now() + interval '20 minutes', 'live', true
         from generate_series(1, $1::int) n`,
        [count],
      );

    it("replaces a live gala, whose slot it takes over", async () => {
      const demo = await gala();
      await fillSlots(DEMO_LIMITS.active - 1);

      expect((await asOrganizer(demo, "reset")).status).toBe(201);
    });

    it("answers 503 and leaves the gala running, with its organizer still in charge", async () => {
      const demo = await gala();
      await fillSlots(DEMO_LIMITS.active);
      const before = await rows(pool, "select status, demo_expires_at from events where id = $1", [demo.eventId]);

      const response = await asOrganizer(demo, "reset");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "demo_capacity" } });

      expect(await rows(pool, "select status, demo_expires_at from events where id = $1", [demo.eventId])).toEqual(before);
      expect((await lotRow(pool, await demo.lot(3))).status).toBe("open");
      expect((await asOrganizer(demo, "close-bidding")).status).toBe(200);
    });
  });

  it("does not keep the organizer waiting for a slow PayPal: the sweep finishes the void", async () => {
    const demo = await gala("Sam");
    const { holdId, authorizationId } = await approveRealHold(pool, demo.eventId, demo.paddleId, 50_000);
    const session = await requirePaddle(demo.slug, withCookie(demo.cookie), pool);
    let finishVoid: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      finishVoid = resolve;
    });

    const started = await resetDemo({
      event: await requireDemoEvent(demo.slug, pool),
      session,
      voidWaitMs: 50,
      dependencies: {
        pool,
        paymentsFor: () =>
          Object.create(getSimulatedPayments(), {
            void: {
              value: async () => {
                await hanging;
                throw new PaypalError({ operation: "void", code: "TIMEOUT" });
              },
            },
          }) as Payments,
      },
    });
    expect(started.slug).not.toBe(demo.slug);
    const statusOf = async () => (await rows<{ status: string }>(pool, "select status from holds where id = $1", [holdId]))[0]?.status;
    expect(await statusOf()).toBe("authorized");
    finishVoid();

    await expect.poll(async () => (await rows(pool, "select 1 from error_log where event_id = $1", [demo.eventId])).length, { timeout: 15_000 }).toBeGreaterThan(0);
    expect(await runSweep({ pool })).toMatchObject({ demosDeleted: 1, voidsFailed: 0 });
    expect((await getSimulatedPayments().getAuthorization(authorizationId)).status).toBe("VOIDED");
  });

  it("does not count the old gala toward the 25 running", async () => {
    const demo = await gala();
    await asOrganizer(demo, "reset");
    const [running] = await rows<{ n: number }>(pool, "select count(*)::int as n from events where is_demo and status = 'live' and closes_at > now()");
    expect(running?.n).toBe(1);
  });

  it("waits for a settlement that is still charging", async () => {
    const demo = await gala();
    await pool.query("update events set status = 'settling' where id = $1", [demo.eventId]);
    await pool.query("insert into settlements (event_id, status) values ($1, 'running')", [demo.eventId]);
    const [{ id: holdId } = { id: "" }] = await rows<{ id: string }>(
      pool,
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, original_authorization_id, current_authorization_id)
       values ($1, $2, 'paypal', 50000, 'authorized', 'A1', 'A1') returning id`,
      [demo.eventId, demo.paddleId],
    );

    const response = await asOrganizer(demo, "reset");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "settlement_running" } });
    const [hold] = await rows<{ status: string }>(pool, "select status from holds where id = $1", [holdId]);
    expect(hold?.status).toBe("authorized");
    expect((await rows<{ n: number }>(pool, "select count(*)::int as n from events where is_demo"))[0]?.n).toBe(1);
  });

  it("brakes one browser replacing its own demo in a loop", async () => {
    const demo = await gala();
    const headers = { cookie: demo.cookie, "x-forwarded-for": "203.0.113.9" };
    const key = clientRateLimitKey(postJson("/x", {}, headers), "demo-reset");
    expect(key).not.toBeNull();
    for (let used = 0; used < 20; used += 1) await takeRateLimit(key ?? "", { limit: 20, windowSeconds: 3_600 }, pool);
    const response = await control(demo.slug, "reset", headers);
    expect(response.status).toBe(429);
    expect((await lotRow(pool, await demo.lot(3))).status).toBe("open");
  });
});
