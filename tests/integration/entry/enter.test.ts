/**
 * The home and join forms' Server Actions on Postgres (src/ui/entry/enter.ts): what a form post gets
 * before the page hydrates, with the session cookie and a redirect or a sentence to show. Also the
 * event layout's demo slot reads (src/ui/demo/demo-state.ts).
 */
import { describe, expect, it } from "vitest";

import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { getSession, type CreatedSession } from "@/server/sessions";
import { sessionCookieName } from "@/server/sessions/cookie";
import { readDemoGala, readGuideProgress } from "@/ui/demo/demo-state";
import { enterDemo, enterEvent, type EntryRequest } from "@/ui/entry/enter";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

/** A browser's request: its address, and the cookie the answer sets. */
function browser(ip: string): EntryRequest & { cookies: CreatedSession[] } {
  const cookies: CreatedSession[] = [];
  return {
    headers: new Headers({ "cf-connecting-ip": ip }),
    setSession: (created) => cookies.push(created),
    cookies,
  };
}

const asCookies = (created: CreatedSession) => ({
  get: (name: string) => (name === sessionCookieName(created.session.eventSlug) ? { value: created.token } : undefined),
});

describe("Start a demo gala (design/16)", () => {
  it("starts a gala with this browser as Jamie, paddle 142, its organizer, and goes to its lots", async () => {
    const request = browser("203.0.113.10");
    const result = await enterDemo(request, "America/Chicago");

    expect(result.kind).toBe("in");
    if (result.kind !== "in") return;
    const slug = result.href.split("/").at(-1) ?? "";
    expect(result.href).toMatch(/^\/e\/gala-[0-9a-z]{16}$/);
    expect(request.cookies).toHaveLength(1);
    const session = await getSession(slug, asCookies(request.cookies[0]!));
    expect(session).toMatchObject({ paddleNumber: 142, firstName: "Jamie", isOrganizer: true });

    const { rows } = await pool.query<{ timezone: string }>("select timezone from events where slug = $1", [slug]);
    expect(rows[0]?.timezone).toBe("America/Chicago");
  });
});

describe("Get my paddle (design/16b)", () => {
  it("gives the next paddle, sets the session and goes to `next` within the event", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    const request = browser("203.0.113.11");
    const result = await enterEvent(request, {
      slug: event.slug,
      firstName: " Kai ",
      next: `/e/${event.slug}/lots/07`,
      session: null,
    });

    expect(result).toEqual({ kind: "in", href: `/e/${event.slug}/lots/07` });
    const session = await getSession(event.slug, asCookies(request.cookies[0]!));
    expect(session).toMatchObject({ firstName: "Kai", isOrganizer: false });
    expect(session?.paddleNumber).not.toBe(142);
  });

  it("never goes to another site", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    const result = await enterEvent(browser("203.0.113.12"), { slug: event.slug, firstName: "Kai", next: "//evil.example", session: null });
    expect(result).toEqual({ kind: "in", href: `/e/${event.slug}` });
  });

  it("keeps what was typed and says why when the name cannot be used", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    const request = browser("203.0.113.13");
    const result = await enterEvent(request, { slug: event.slug, firstName: "   ", next: null, session: null });

    expect(result).toEqual({ kind: "refused", state: { error: "Enter a first name of up to 40 characters.", firstName: "   ", href: null } });
    expect(request.cookies).toHaveLength(0);
  });

  it("refuses once bidding has closed, with the route's sentence", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    await pool.query("update events set status = 'closed', closed_at = now() where id = $1", [event.id]);
    const result = await enterEvent(browser("203.0.113.14"), { slug: event.slug, firstName: "Kai", next: null, session: null });
    expect(result).toEqual({ kind: "refused", state: { error: "Bidding has closed for this event.", firstName: "Kai", href: null } });
  });

  it("keeps the paddle a browser already has", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    const first = browser("203.0.113.15");
    await enterEvent(first, { slug: event.slug, firstName: "Kai", next: null, session: null });
    const session = await getSession(event.slug, asCookies(first.cookies[0]!));

    const again = browser("203.0.113.15");
    expect(await enterEvent(again, { slug: event.slug, firstName: "Someone", next: null, session })).toEqual({
      kind: "in",
      href: `/e/${event.slug}`,
    });
    expect(again.cookies).toHaveLength(0);
  });
});

describe("the demo slot's reads", () => {
  it("tells a demo gala from the seeded event, and an ended or deleted gala from both", async () => {
    const { event } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    expect(await readDemoGala(event.slug, pool)).toMatchObject({ kind: "event", isDemo: true, status: "live" });

    const fixture = await createFixtureEvent({ slug: "entry-fixture" }, pool);
    expect(await readDemoGala(fixture.event.slug, pool)).toMatchObject({ kind: "event", isDemo: false });

    // Reset ends a gala by moving demo_expires_at to now (src/server/director/controls.ts).
    await pool.query("update events set demo_expires_at = now() where id = $1", [event.id]);
    expect(await readDemoGala(event.slug, pool)).toEqual({ kind: "ended" });

    expect(await readDemoGala("gala-0000000000000000", pool)).toEqual({ kind: "missing" });
    expect(await readDemoGala("gala-\u0000", pool)).toEqual({ kind: "missing" });
  });

  it("reads the guide's steps from what the database already keeps", async () => {
    const { creator } = await createDemoEvent({ creatorFirstName: "Jamie" }, pool);
    expect(await readGuideProgress({ paddleId: creator.paddleId, status: "live" }, pool)).toEqual({
      power: false,
      heart: false,
      bid: false,
      close: false,
      charge: false,
    });
    expect(await readGuideProgress({ paddleId: creator.paddleId, status: "settled" }, pool)).toMatchObject({ close: true, charge: true });
  });
});
