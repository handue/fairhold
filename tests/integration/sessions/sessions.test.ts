/**
 * Sessions on Postgres: the token is never stored, a session answers only for its own event, and
 * organizer rights stop at that event.
 */
import { describe, expect, it } from "vitest";

import { ApiError } from "@/server/api";
import { attachSessionCookie, createSession, getSession, requireOrganizer, requirePaddle, requireSession, sessionCookieName } from "@/server/sessions";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

async function event(): Promise<{ id: string; slug: string }> {
  const id = await createEvent(pool);
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [id]);
  return { id, slug: rows[0]?.slug ?? "" };
}

const browser = (slug: string, token: string) =>
  new Request("https://fairhold.example/e", { headers: { cookie: `other=1; ${sessionCookieName(slug)}=${token}` } });

async function codeOf(call: Promise<unknown>): Promise<[number, string]> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiError) return [error.status, error.code];
    throw error;
  }
  throw new Error("the guard let it through");
}

describe("createSession and getSession", () => {
  it("stores only a hash of the token", async () => {
    const gala = await event();
    const paddleId = await createPaddle(pool, gala.id, 188);
    const { session, token } = await createSession({ eventId: gala.id, paddleId }, pool);

    const { rows } = await pool.query<{ token_hash: string }>("select token_hash from sessions where id = $1", [session.id]);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.token_hash).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("finds the session from a request or from cookies()", async () => {
    const gala = await event();
    const paddleId = await createPaddle(pool, gala.id, 188);
    const { session, token } = await createSession({ eventId: gala.id, paddleId }, pool);

    const expected = {
      id: session.id,
      eventId: gala.id,
      eventSlug: gala.slug,
      paddleId,
      paddleNumber: 188,
      firstName: "Guest 188",
      isOrganizer: false,
      organizerName: null,
    };
    expect(session).toEqual(expected);
    await expect(getSession(gala.slug, browser(gala.slug, token), pool)).resolves.toEqual(expected);
    const jar = { get: (name: string) => (name === sessionCookieName(gala.slug) ? { name, value: token } : undefined) };
    await expect(getSession(gala.slug, jar, pool)).resolves.toEqual(expected);
  });

  it("is null with no cookie, a wrong token or another event's cookie", async () => {
    const gala = await event();
    const other = await event();
    const { token } = await createSession({ eventId: gala.id, paddleId: null }, pool);

    await expect(getSession(gala.slug, new Request("https://fairhold.example/e"), pool)).resolves.toBeNull();
    await expect(getSession(gala.slug, browser(gala.slug, "not-the-token"), pool)).resolves.toBeNull();
    await expect(getSession(other.slug, browser(gala.slug, token), pool)).resolves.toBeNull();
    // A cookie renamed by hand still belongs to its own event.
    await expect(getSession(other.slug, browser(other.slug, token), pool)).resolves.toBeNull();
  });

  it("keeps one browser in two events at once", async () => {
    const first = await event();
    const second = await event();
    const a = await createSession({ eventId: first.id, paddleId: await createPaddle(pool, first.id, 101) }, pool);
    const b = await createSession({ eventId: second.id, paddleId: await createPaddle(pool, second.id, 102) }, pool);
    const cookie = `${sessionCookieName(first.slug)}=${a.token}; ${sessionCookieName(second.slug)}=${b.token}`;
    const both = new Request("https://fairhold.example/e", { headers: { cookie } });

    expect((await getSession(first.slug, both, pool))?.paddleNumber).toBe(101);
    expect((await getSession(second.slug, both, pool))?.paddleNumber).toBe(102);
  });

  it("stops working after a week without use, and writes last_seen_at at most once a minute", async () => {
    const gala = await event();
    const { session, token } = await createSession({ eventId: gala.id, paddleId: null }, pool);
    const seen = async () =>
      (await pool.query<{ age: number }>("select extract(epoch from now() - last_seen_at)::float8 as age from sessions where id = $1", [session.id])).rows[0]?.age ?? -1;
    const age = (interval: string) => pool.query(`update sessions set last_seen_at = now() - interval '${interval}' where id = $1`, [session.id]);

    await age("30 seconds");
    await getSession(gala.slug, browser(gala.slug, token), pool);
    expect(await seen()).toBeGreaterThan(29);

    await age("5 minutes");
    await getSession(gala.slug, browser(gala.slug, token), pool);
    expect(await seen()).toBeLessThan(5);

    await age("6 days");
    expect(await getSession(gala.slug, browser(gala.slug, token), pool)).not.toBeNull();

    await age("8 days");
    expect(await getSession(gala.slug, browser(gala.slug, token), pool)).toBeNull();
  });
});

describe("attachSessionCookie", () => {
  it("lives a week on a real event", async () => {
    const gala = await event();
    const created = await createSession({ eventId: gala.id, paddleId: null }, pool);
    expect(created.maxAgeSeconds).toBe(7 * 24 * 60 * 60);
    const header = attachSessionCookie(new Response(), created).headers.get("set-cookie") ?? "";
    expect(header).toContain(`${sessionCookieName(gala.slug)}=${created.token}`);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
  });

  it("lives as long as a demo, at least an hour", async () => {
    const gala = await event();
    await pool.query("update events set is_demo = true, demo_expires_at = now() + interval '6 hours' where id = $1", [gala.id]);
    const created = await createSession({ eventId: gala.id, paddleId: null }, pool);
    expect(created.maxAgeSeconds).toBeGreaterThan(6 * 60 * 60 - 60);
    expect(created.maxAgeSeconds).toBeLessThanOrEqual(6 * 60 * 60);

    await pool.query("update events set demo_expires_at = now() + interval '1 minute' where id = $1", [gala.id]);
    expect((await createSession({ eventId: gala.id, paddleId: null }, pool)).maxAgeSeconds).toBe(60 * 60);
  });
});

describe("the guards", () => {
  it("requireSession answers 401 not_joined with no session", async () => {
    const gala = await event();
    expect(await codeOf(requireSession(gala.slug, new Request("https://fairhold.example/e"), pool))).toEqual([401, "not_joined"]);
  });

  it("requirePaddle wants a session that holds a paddle", async () => {
    const gala = await event();
    const noPaddle = await createSession({ eventId: gala.id, paddleId: null, isOrganizer: true }, pool);
    expect(await codeOf(requirePaddle(gala.slug, browser(gala.slug, noPaddle.token), pool))).toEqual([401, "not_joined"]);

    const paddleId = await createPaddle(pool, gala.id, 188);
    const guest = await createSession({ eventId: gala.id, paddleId }, pool);
    await expect(requirePaddle(gala.slug, browser(gala.slug, guest.token), pool)).resolves.toMatchObject({ paddleId, paddleNumber: 188 });
  });

  it("requireOrganizer covers this session's event and no other", async () => {
    const gala = await event();
    const other = await event();
    const organizer = await createSession({ eventId: gala.id, paddleId: null, isOrganizer: true, organizerName: "Dana" }, pool);
    const guest = await createSession({ eventId: gala.id, paddleId: null }, pool);

    await expect(requireOrganizer(gala.slug, browser(gala.slug, organizer.token), pool)).resolves.toMatchObject({ isOrganizer: true, organizerName: "Dana" });
    expect(await codeOf(requireOrganizer(gala.slug, browser(gala.slug, guest.token), pool))).toEqual([403, "organizer_only"]);
    expect(await codeOf(requireOrganizer(other.slug, browser(gala.slug, organizer.token), pool))).toEqual([401, "not_joined"]);
    expect(await codeOf(requireOrganizer(other.slug, browser(other.slug, organizer.token), pool))).toEqual([401, "not_joined"]);
  });
});
