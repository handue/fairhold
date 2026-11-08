/** POST /api/events/[slug]/join on Postgres: next paddle numbers, and one paddle per browser. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/events/[slug]/join/route";
import { createSession, requireOrganizer, requirePaddle, sessionCookieName } from "@/server/api";
import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

import { cookieFrom, postJson, withCookie } from "./support";

const { pool } = getTestDatabase();

interface Joined {
  slug: string;
  paddleNumber: number;
  firstName: string;
  href: string;
}

const join = (slug: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(postJson(`/api/events/${slug}/join`, body, headers), { params: Promise.resolve({ slug }) });

async function newEvent(status = "live"): Promise<{ id: string; slug: string }> {
  const id = await createEvent(pool, status);
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [id]);
  return { id, slug: rows[0]?.slug ?? "" };
}

const paddleCount = async (eventId: string) =>
  (await pool.query<{ n: number }>("select count(*)::int as n from paddles where event_id = $1", [eventId])).rows[0]?.n ?? 0;

describe("who may join in production", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a seeded event, which no organizer can ever charge or release", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { id, slug } = await newEvent();

    const response = await join(slug, { firstName: "Stranger" }, { "x-forwarded-for": "203.0.113.70" });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "event_view_only" } });
    expect(await paddleCount(id)).toBe(0);
  });

  it("takes a demo gala's guests", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    vi.stubEnv("NODE_ENV", "production");

    expect((await join(event.slug, { firstName: "Kai" }, { "x-forwarded-for": "203.0.113.71" })).status).toBe(201);
  });
});

describe("POST /api/events/[slug]/join", () => {
  it("gives a demo's guest the next paddle after the template's, real and without rights", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    const before = await pool.query<{ top: number }>("select max(number)::int as top from paddles where event_id = $1", [event.id]);
    const top = before.rows[0]?.top ?? 0;

    const response = await join(event.slug, { firstName: " Mary   Ann " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      slug: event.slug,
      paddleNumber: top + 1,
      firstName: "Mary Ann",
      href: `/e/${event.slug}`,
    });

    const request = withCookie(cookieFrom(response));
    await expect(requirePaddle(event.slug, request, pool)).resolves.toMatchObject({ paddleNumber: top + 1, firstName: "Mary Ann", isOrganizer: false });
    await expect(requireOrganizer(event.slug, request, pool)).rejects.toMatchObject({ status: 403, code: "organizer_only" });
    const row = await pool.query<{ is_simulated: boolean; holds: number }>(
      `select p.is_simulated, (select count(*)::int from holds h where h.paddle_id = p.id) as holds
       from paddles p where p.event_id = $1 and p.number = $2`,
      [event.id, top + 1],
    );
    expect(row.rows[0]).toEqual({ is_simulated: false, holds: 0 });
  });

  it("starts at 101 on an event with no paddles", async () => {
    const gala = await newEvent();
    const response = await join(gala.slug, { firstName: "Sam" });
    expect(((await response.json()) as Joined).paddleNumber).toBe(101);
  });

  it("never races: many browsers at once get consecutive numbers", async () => {
    const gala = await newEvent();
    await createPaddle(pool, gala.id, 200);

    const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => join(gala.slug, { firstName: `Guest ${index}` })));

    expect(responses.map((response) => response.status)).toEqual(Array(30).fill(201));
    const numbers = await Promise.all(responses.map(async (response) => ((await response.json()) as Joined).paddleNumber));
    expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, index) => 201 + index));
    expect(new Set(responses.map(cookieFrom)).size).toBe(30);
  });

  it("numbers each event on its own", async () => {
    const first = await newEvent();
    const second = await newEvent();
    await createPaddle(pool, first.id, 300);
    const responses = await Promise.all([join(first.slug, { firstName: "Sam" }), join(second.slug, { firstName: "Kai" })]);
    const numbers = await Promise.all(responses.map(async (response) => ((await response.json()) as Joined).paddleNumber));
    expect(numbers).toEqual([301, 101]);
  });

  it("keeps one paddle per browser: a second join changes nothing", async () => {
    const gala = await newEvent();
    const first = await join(gala.slug, { firstName: "Sam" });
    const firstBody = (await first.json()) as Joined;

    const second = await join(gala.slug, { firstName: "Someone Else" }, { cookie: cookieFrom(first) });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(await paddleCount(gala.id)).toBe(1);
  });

  it("does not take a cookie from another event for this one", async () => {
    const first = await newEvent();
    const second = await newEvent();
    const inFirst = await join(first.slug, { firstName: "Sam" });
    const inSecond = await join(second.slug, { firstName: "Sam" }, { cookie: cookieFrom(inFirst) });
    expect(inSecond.status).toBe(201);
    expect(await paddleCount(second.id)).toBe(1);
  });

  it("gives an organizer without a paddle one on their session", async () => {
    const gala = await newEvent();
    const organizer = await createSession({ eventId: gala.id, paddleId: null, isOrganizer: true, organizerName: "Dana" }, pool);
    const cookie = `${sessionCookieName(gala.slug)}=${organizer.token}`;

    const response = await join(gala.slug, { firstName: "Dana" }, { cookie });
    expect(response.status).toBe(200);
    expect(((await response.json()) as Joined).paddleNumber).toBe(101);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(requirePaddle(gala.slug, withCookie(cookie), pool)).resolves.toMatchObject({ paddleNumber: 101, isOrganizer: true });
  });

  it("works on the seeded fixture, whatever day it is", async () => {
    await createFixtureEvent({}, pool);
    const response = await join(FIXTURE_SLUG, { firstName: "Sam" });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Joined).paddleNumber).toBeGreaterThan(142);
  });

  it("answers 404 for an unknown event", async () => {
    const response = await join("gala-nothing", { firstName: "Sam" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "event_not_found" } });
  });

  it.each(["closed", "settling", "settled"])("answers 409 once the event is %s", async (status) => {
    const gala = await newEvent(status);
    const response = await join(gala.slug, { firstName: "Sam" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "event_closed", message: "Bidding has closed for this event." } });
    expect(await paddleCount(gala.id)).toBe(0);
  });

  it("refuses a bad name, another site and too many joins", async () => {
    const gala = await newEvent();
    expect((await join(gala.slug, { firstName: "" })).status).toBe(400);
    expect((await join(gala.slug, {})).status).toBe(400);
    expect((await join(gala.slug, { firstName: "Sam" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await paddleCount(gala.id)).toBe(0);

    const client = { "x-forwarded-for": "203.0.113.50" };
    const responses = [];
    for (let index = 0; index < 61; index += 1) responses.push(await join(gala.slug, { firstName: "Sam" }, client));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(60);
    const last = responses.at(-1);
    expect(last?.status).toBe(429);
    expect(await last?.json()).toMatchObject({ error: { code: "rate_limited" } });
    expect(await paddleCount(gala.id)).toBe(60);
  });
});
