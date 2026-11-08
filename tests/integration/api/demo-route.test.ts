/** POST /api/demo on Postgres: a gala, its creator's session, and the two limits. */
import { randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/demo/route";
import { requireOrganizer, requirePaddle } from "@/server/api";

import { getTestDatabase } from "../../helpers/database";

import { cookieFrom, postJson, withCookie } from "./support";

const { pool } = getTestDatabase();

const start = (body: unknown, headers: Record<string, string> = {}) => POST(postJson("/api/demo", body, headers), undefined);

interface Started {
  slug: string;
  paddleNumber: number;
  firstName: string;
  href: string;
}

const demoCount = async () =>
  (await pool.query<{ n: number }>("select count(*)::int as n from events where is_demo")).rows[0]?.n ?? 0;

/** Lightweight rows that count as running demos, without the cost of a whole gala. */
async function runningDemos(count: number, closes = "now() + interval '20 minutes'", status = "live"): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `insert into events (slug, name, charity_name, closes_at, status, is_demo, demo_expires_at)
       values ($1, 'Running', 'Charity', ${closes}, $2, true, now() + interval '6 hours')`,
      [`gala-${randomBytes(6).toString("hex")}`, status],
    );
  }
}

beforeEach(async () => {
  await pool.query("delete from events; delete from rate_limits");
});

afterEach(async () => {
  await pool.query("delete from events; delete from rate_limits");
});

describe("POST /api/demo", () => {
  it("starts a gala and signs the browser in as its paddle 142", async () => {
    const response = await start({ firstName: "  Sam ", timeZone: "America/Chicago" });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Started;
    expect(body).toEqual({
      slug: expect.stringMatching(/^gala-[0-9a-hjkmnp-tv-z]{16}$/),
      paddleNumber: 142,
      firstName: "Sam",
      href: `/e/${body.slug}`,
    });

    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`fh_s_${body.slug}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");

    const request = withCookie(cookieFrom(response));
    await expect(requirePaddle(body.slug, request, pool)).resolves.toMatchObject({ paddleNumber: 142, firstName: "Sam" });

    const { rows } = await pool.query<{ timezone: string; lots: number; paddles: number }>(
      `select e.timezone,
         (select count(*)::int from lots where event_id = e.id) as lots,
         (select count(*)::int from paddles where event_id = e.id) as paddles
       from events e where e.slug = $1`,
      [body.slug],
    );
    expect(rows[0]).toEqual({ timezone: "America/Chicago", lots: 24, paddles: 86 });
  });

  it("makes the creator the organizer of this event, and of no other", async () => {
    const first = await start({ firstName: "Sam" });
    const second = await start({ firstName: "Kai" });
    const firstSlug = ((await first.json()) as Started).slug;
    const secondSlug = ((await second.json()) as Started).slug;
    const cookie = cookieFrom(first);

    await expect(requireOrganizer(firstSlug, withCookie(cookie), pool)).resolves.toMatchObject({ isOrganizer: true, organizerName: "Sam" });
    await expect(requireOrganizer(secondSlug, withCookie(cookie), pool)).rejects.toMatchObject({ status: 401, code: "not_joined" });
    await expect(requireOrganizer(secondSlug, withCookie(cookie.replace(firstSlug, secondSlug)), pool)).rejects.toMatchObject({ status: 401 });
  });

  it("falls back to the gala's own time zone for one it does not recognize", async () => {
    const response = await start({ firstName: "Sam", timeZone: "Mars/Olympus" });
    const { slug } = (await response.json()) as Started;
    const { rows } = await pool.query<{ timezone: string }>("select timezone from events where slug = $1", [slug]);
    expect(rows[0]?.timezone).toBe("America/Los_Angeles");
  });

  it("refuses a bad first name with a sentence a guest can read, and starts nothing", async () => {
    for (const firstName of ["   ", "x".repeat(41), "Sam\u0007"]) {
      const response = await start({ firstName });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_first_name", message: "Enter a first name of up to 40 characters.", details: null },
      });
    }
    expect(await demoCount()).toBe(0);
  });

  it("refuses a body that is not what it asks for", async () => {
    expect((await start({})).status).toBe(400);
    expect((await start({ firstName: "Sam", timeZone: "x".repeat(65) })).status).toBe(400);
    const notJson = new Request("https://fairhold.example/api/demo", { method: "POST", headers: { "content-type": "text/plain" }, body: "Sam" });
    expect((await POST(notJson, undefined)).status).toBe(415);
    expect(await demoCount()).toBe(0);
  });

  it("refuses another site", async () => {
    const response = await start({ firstName: "Sam" }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross_origin" } });
    expect(await demoCount()).toBe(0);
  });
});

describe("the per-client limit", () => {
  const client = (ip: string) => ({ "x-forwarded-for": ip });

  it("allows 5 demos per client per hour, and says when to come back", { timeout: 60_000 }, async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await start({ firstName: "Sam" }, client("203.0.113.1"))).status).toBe(201);
    }
    const refused = await start({ firstName: "Sam" }, client("203.0.113.1"));
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as { error: { code: string; message: string; details: { retryAfterSeconds: number } } };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("You’ve started several demo galas in the last hour. Please try again later.");
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.error.details.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    expect(refused.headers.get("retry-after")).toBe(String(body.error.details.retryAfterSeconds));
    expect(refused.headers.get("set-cookie")).toBeNull();
    expect(await demoCount()).toBe(5);

    expect((await start({ firstName: "Kai" }, client("203.0.113.2"))).status).toBe(201);
    expect(await demoCount()).toBe(6);
  });

  it("stores no address", async () => {
    await start({ firstName: "Sam" }, client("203.0.113.1"));
    const { rows } = await pool.query<{ key: string }>("select key from rate_limits");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toMatch(/^demo:[0-9a-f]{32}$/);
  });

  it("does not apply on a developer's own machine", async () => {
    expect((await start({ firstName: "Sam" }, client("::1"))).status).toBe(201);
    const { rows } = await pool.query("select key from rate_limits");
    expect(rows).toHaveLength(0);
  });
});

describe("the limit on running demos", () => {
  it("refuses the 26th, without touching the client's own count", async () => {
    await runningDemos(25);
    const refused = await start({ firstName: "Sam" }, { "x-forwarded-for": "203.0.113.1" });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({
      error: { code: "demo_capacity", message: "Too many demo galas are running right now. Please try again in a few minutes." },
    });
    expect(refused.headers.get("retry-after")).toBe("300");
    expect(await demoCount()).toBe(25);
    expect((await pool.query("select key from rate_limits")).rows).toHaveLength(0);
  });

  it("does not apply under next dev, where end-to-end runs pile up in one database", async () => {
    await runningDemos(25);
    vi.stubEnv("NODE_ENV", "development");
    expect((await start({ firstName: "Sam" })).status).toBe(201);
    vi.unstubAllEnvs();
  });

  it("counts only demos still taking bids", async () => {
    await runningDemos(24);
    await runningDemos(3, "now() - interval '1 minute'");
    await runningDemos(3, "now() + interval '20 minutes'", "closed");
    await pool.query(
      `insert into events (slug, name, charity_name, closes_at, status) values ('showcase', 'Not a demo', 'Charity', now() + interval '1 hour', 'live')`,
    );
    expect((await start({ firstName: "Sam" })).status).toBe(201);
    expect((await start({ firstName: "Kai" })).status).toBe(503);
  });

  it("lets exactly one through when several race for the last place", async () => {
    await runningDemos(24);
    const responses = await Promise.all([1, 2, 3, 4, 5].map((index) => start({ firstName: `Guest ${index}` })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 503, 503, 503, 503]);
    const running = await pool.query<{ n: number }>("select count(*)::int as n from events where is_demo and status = 'live' and closes_at > now()");
    expect(running.rows[0]?.n).toBe(25);
  });
});
