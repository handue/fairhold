/**
 * The hold's whole round trip on Postgres, through the real routes and with simulated payments:
 * POST /api/holds/[slug], the window's return or cancel page, and bidding power the guest can bid
 * with. This is what the 09 page does in a browser, minus the browser.
 */
import { describe, expect, it } from "vitest";

import { GET as holdStatus } from "@/app/api/holds/[slug]/[holdId]/route";
import { POST as openWindow } from "@/app/api/holds/[slug]/route";
import { GET as cancelPage } from "@/app/paypal/cancel/route";
import { GET as returnPage } from "@/app/paypal/return/route";
import { createSession, sessionCookieName } from "@/server/api";
import { createDemoEvent } from "@/server/demo/createDemoEvent";
import { getBiddingPower, placeBid } from "@/server/engine";
import { getPowerView } from "@/server/holds/view";
import { getCatalogView } from "@/server/queries/catalog";
import { canSeeStreamRow } from "@/server/sse/types";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

const { pool } = getTestDatabase();

const ORIGIN = "https://fairhold.example";

interface Guest {
  slug: string;
  eventId: string;
  paddleId: string;
  cookie: string;
}

async function demoGuest(): Promise<Guest> {
  const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
  const { token } = await createSession({ eventId: event.id, paddleId: creator.paddleId, isOrganizer: true }, pool);
  return { slug: event.slug, eventId: event.id, paddleId: creator.paddleId, cookie: `${sessionCookieName(event.slug)}=${token}` };
}

async function secondGuest(guest: Guest): Promise<Guest> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into paddles (event_id, number, first_name) values ($1, 900, 'Kai') returning id`,
    [guest.eventId],
  );
  const paddleId = rows[0]?.id ?? "";
  const { token } = await createSession({ eventId: guest.eventId, paddleId }, pool);
  return { ...guest, paddleId, cookie: `${sessionCookieName(guest.slug)}=${token}` };
}

const open = (guest: Pick<Guest, "slug" | "cookie">, body: unknown, headers: Record<string, string> = {}) =>
  openWindow(postJson(`/api/holds/${guest.slug}`, body, { cookie: guest.cookie, ...headers }), {
    params: Promise.resolve({ slug: guest.slug }),
  });

interface Opened {
  holdId: string;
  amountCents: number;
  approvalUrl: string;
}

async function openOk(guest: Guest, amountCents: number, next?: string): Promise<Opened> {
  const response = await open(guest, { amountCents, next });
  expect(response.status).toBe(201);
  return (await response.json()) as Opened;
}

const status = (guest: Pick<Guest, "slug" | "cookie">, holdId: string) =>
  holdStatus(new Request(`${ORIGIN}/api/holds/${guest.slug}/${holdId}`, { headers: { cookie: guest.cookie } }), {
    params: Promise.resolve({ slug: guest.slug, holdId }),
  });

const power = async (paddleId: string) => (await getBiddingPower([paddleId], pool)).get(paddleId);

async function nav(guest: Guest, paddleNumber = 142) {
  return (await getCatalogView({ slug: guest.slug, paddleNumber, category: null }))?.viewer;
}

describe("the hold round trip", () => {
  it("makes a hold approved in the window the bidding power the nav shows and the engine enforces", async () => {
    const guest = await demoGuest();
    expect(await nav(guest)).toMatchObject({ holdCents: null });

    const { holdId, approvalUrl } = await openOk(guest, 500_00, `/e/${guest.slug}/lots/07`);
    expect(new URL(approvalUrl).origin).toBe(ORIGIN);
    // Nothing is bidding power until the guest approves.
    expect(await nav(guest)).toMatchObject({ holdCents: null });
    await expect((await status(guest, holdId)).json()).resolves.toEqual({ holdId, status: "pending_approval", amountCents: 500_00 });

    // Simulated approval is instant: the link is the real return page.
    const page = await returnPage(new Request(approvalUrl));
    expect(page.status).toBe(200);
    const html = await page.text();
    // design/17 frame 3, with the hold's event and paddle over the heading.
    expect(html).toContain("$500 is held with PayPal.");
    expect(html).toContain("Riverside Shelter Gala · Paddle 142");
    expect(html).toContain(`"holdId":"${holdId}"`);
    expect(html).toContain('"outcome":"approved"');
    expect(html).toContain("window.opener.postMessage");
    expect(html).toContain(`window.location.replace("/e/${guest.slug}/lots/07")`);

    expect(await nav(guest)).toMatchObject({ holdCents: 500_00, availableCents: 500_00 });
    expect(await power(guest.paddleId)).toMatchObject({ holdId, holdCents: 500_00, committedCents: 0 });
    await expect((await status(guest, holdId)).json()).resolves.toEqual({ holdId, status: "authorized", amountCents: 500_00 });

    const { rows: lots } = await pool.query<{ id: string; next: number }>(
      `select id, coalesce(current_bid_cents + min_raise_cents, starting_bid_cents) as next
       from lots where event_id = $1 and number = 7`,
      [guest.eventId],
    );
    const lot = lots[0];
    if (!lot) throw new Error("the demo has no lot 7");
    await expect(placeBid(guest.paddleId, lot.id, lot.next, "guest", { pool })).resolves.toMatchObject({ ok: true });
    expect(await power(guest.paddleId)).toMatchObject({ committedCents: lot.next });
  });

  it("writes the rows the stream carries, on the paddle's own channel", async () => {
    const guest = await demoGuest();
    const { holdId, approvalUrl } = await openOk(guest, 500_00);
    await returnPage(new Request(approvalUrl));

    const { rows } = await pool.query<{ paddle_id: string; type: "hold"; payload: unknown }>(
      "select paddle_id, type, payload from event_log where event_id = $1 and type = 'hold' order by id",
      [guest.eventId],
    );
    const own = rows.filter((row) => row.paddle_id === guest.paddleId);
    expect(own.map((row) => row.payload)).toEqual([
      { holdId, status: "pending_approval" },
      { holdId, status: "authorized", amountCents: 500_00 },
    ]);
    const [row] = own;
    if (!row) throw new Error("no hold row");
    const shape = { type: row.type, paddleId: row.paddle_id };
    expect(canSeeStreamRow(shape, { paddleId: guest.paddleId, isOrganizer: false })).toBe(true);
    expect(canSeeStreamRow(shape, { paddleId: "another-paddle", isOrganizer: false })).toBe(false);
    expect(canSeeStreamRow(shape, { paddleId: "another-paddle", isOrganizer: true })).toBe(true);
  });

  it("raises by approving the new total and voiding the old hold, with one authorized throughout", async () => {
    const guest = await demoGuest();
    const first = await openOk(guest, 500_00);
    await returnPage(new Request(first.approvalUrl));

    const raise = await openOk(guest, 1_000_00);
    // Until the guest approves, the hold in place stays as it is.
    expect(await nav(guest)).toMatchObject({ holdCents: 500_00 });

    await returnPage(new Request(raise.approvalUrl));

    expect(await nav(guest)).toMatchObject({ holdCents: 1_000_00, availableCents: 1_000_00 });
    const { rows } = await pool.query<{ id: string; status: string }>(
      "select id, status from holds where paddle_id = $1 order by created_at, id",
      [guest.paddleId],
    );
    expect(rows).toEqual([
      { id: first.holdId, status: "voided" },
      { id: raise.holdId, status: "authorized" },
    ]);
  });

  it("leaves nothing held after a canceled window, and the guest can try again", async () => {
    const guest = await demoGuest();
    const { holdId, approvalUrl } = await openOk(guest, 500_00, `/e/${guest.slug}/lots/07`);

    const cancelUrl = approvalUrl.replace("/paypal/return", "/paypal/cancel");
    const page = await cancelPage(new Request(cancelUrl));
    const html = await page.text();
    expect(html).toContain('"outcome":"canceled"');
    // design/17 frame 4 has "Close window"; a full-page trip goes back to bidding power by itself.
    expect(html).toContain(`window.location.replace("/e/${guest.slug}/power?next=%2Fe%2F${guest.slug}%2Flots%2F07")`);

    expect(await nav(guest)).toMatchObject({ holdCents: null });
    await expect((await status(guest, holdId)).json()).resolves.toMatchObject({ status: "canceled" });
    // Approving a canceled window later holds nothing either.
    expect(await (await returnPage(new Request(approvalUrl))).text()).toContain('"outcome":"canceled"');
    expect(await nav(guest)).toMatchObject({ holdCents: null });

    const again = await openOk(guest, 500_00);
    await returnPage(new Request(again.approvalUrl));
    expect(await nav(guest)).toMatchObject({ holdCents: 500_00 });
  });

  it("releases a smaller window approved after a larger one, and explains why in the window", async () => {
    const guest = await demoGuest();
    const smaller = await openOk(guest, 600_00);
    const larger = await openOk(guest, 800_00);

    await returnPage(new Request(larger.approvalUrl));
    const page = await returnPage(new Request(smaller.approvalUrl));

    expect(page.status).toBe(409);
    const html = await page.text();
    expect(html).toContain('"outcome":"refused"');
    expect(html).toContain("Your bidding power stays at $800");
    expect(await nav(guest)).toMatchObject({ holdCents: 800_00 });
    await expect((await status(guest, smaller.holdId)).json()).resolves.toMatchObject({ status: "voided" });
  });

  it("refuses an approval that comes after bidding closed", async () => {
    const guest = await demoGuest();
    const { approvalUrl } = await openOk(guest, 500_00);
    await pool.query("update events set status = 'closed' where id = $1", [guest.eventId]);

    const html = await (await returnPage(new Request(approvalUrl))).text();

    expect(html).toContain('"outcome":"refused"');
    expect(html).toContain("Bidding has closed");
    expect(await nav(guest)).toMatchObject({ holdCents: null });
  });
});

describe("POST /api/holds/[slug]", () => {
  it("needs a session in this event", async () => {
    const guest = await demoGuest();
    const response = await open({ slug: guest.slug, cookie: "" }, { amountCents: 500_00 });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "not_joined" } });

    const other = await demoGuest();
    const wrongEvent = await open({ slug: guest.slug, cookie: other.cookie }, { amountCents: 500_00 });
    expect(wrongEvent.status).toBe(401);
  });

  it("refuses another site", async () => {
    const guest = await demoGuest();
    const response = await open(guest, { amountCents: 500_00 }, { origin: "https://evil.example" });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "cross_origin" } });
    expect(await power(guest.paddleId)).toMatchObject({ holdId: null });
  });

  it.each([[{}], [{ amountCents: "500" }], [{ amountCents: 500.5 }], [{ amountCents: -100 }], [{ amountCents: 0 }]])(
    "answers 400 for the body %j",
    async (body) => {
      const guest = await demoGuest();
      const response = await open(guest, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_request" } });
    },
  );

  it("answers the guest's refusals in the error envelope", async () => {
    const guest = await demoGuest();
    const tooMuch = await open(guest, { amountCents: 1_200_00 });
    expect(tooMuch.status).toBe(400);
    await expect(tooMuch.json()).resolves.toEqual({
      error: { code: "amount_above_maximum", message: "The most you can hold is $1,000.", details: { maxCents: 1_000_00 } },
    });

    const { approvalUrl } = await openOk(guest, 500_00);
    await returnPage(new Request(approvalUrl));
    const notARaise = await open(guest, { amountCents: 500_00 });
    expect(notARaise.status).toBe(409);
    await expect(notARaise.json()).resolves.toMatchObject({
      error: { code: "not_a_raise", details: { currentHoldCents: 500_00 } },
    });
  });

  it("uses the configured public origin for PayPal's URLs, not the request's", async () => {
    const guest = await demoGuest();
    const previous = process.env.RENDER_EXTERNAL_URL;
    process.env.RENDER_EXTERNAL_URL = "https://fairhold.onrender.example/";
    try {
      const { approvalUrl } = await openOk(guest, 500_00);
      expect(new URL(approvalUrl).origin).toBe("https://fairhold.onrender.example");
    } finally {
      if (previous === undefined) delete process.env.RENDER_EXTERNAL_URL;
      else process.env.RENDER_EXTERNAL_URL = previous;
    }
  });
});

describe("GET /api/holds/[slug]/[holdId]", () => {
  it("answers only about the guest's own hold", async () => {
    const guest = await demoGuest();
    const { holdId } = await openOk(guest, 500_00);
    const kai = await secondGuest(guest);

    const response = await status(kai, holdId);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "hold_not_found" } });
    expect((await status({ slug: guest.slug, cookie: "" }, holdId)).status).toBe(401);
  });

  it.each(["not-a-uuid", "00000000-0000-4000-8000-000000000000", "../../etc"])("answers 404 for the hold id %s", async (holdId) => {
    const guest = await demoGuest();
    expect((await status(guest, holdId)).status).toBe(404);
  });
});

describe("getPowerView", () => {
  it("is the setup page before a hold, with the event's rules and the approved example", async () => {
    const guest = await demoGuest();
    const view = await getPowerView({ slug: guest.slug, paddleNumber: 142 });
    expect(view).toMatchObject({
      viewer: { paddleNumber: 142, firstName: "Sam", holdCents: null },
      limits: { presetsCents: [250_00, 500_00, 1_000_00], minCents: 25_00, maxCents: 1_000_00 },
      currentHoldCents: null,
      committedCents: 0,
      biddingEnded: false,
      exampleLot: "Chef’s Table Dinner",
    });
  });

  it("knows the hold in place, once there is one", async () => {
    const guest = await demoGuest();
    const { approvalUrl } = await openOk(guest, 500_00);
    await returnPage(new Request(approvalUrl));
    expect(await getPowerView({ slug: guest.slug, paddleNumber: 142 })).toMatchObject({ currentHoldCents: 500_00 });
  });

  it("knows when bidding has ended, by status or by the clock", async () => {
    const guest = await demoGuest();
    await pool.query("update events set closes_at = now() - interval '1 minute' where id = $1", [guest.eventId]);
    expect(await getPowerView({ slug: guest.slug, paddleNumber: 142 })).toMatchObject({ biddingEnded: true });

    const closed = await demoGuest();
    await pool.query("update events set status = 'closed' where id = $1", [closed.eventId]);
    expect(await getPowerView({ slug: closed.slug, paddleNumber: 142 })).toMatchObject({ biddingEnded: true });
  });

  it("has no viewer for a visitor, and no view for an unknown event", async () => {
    const guest = await demoGuest();
    expect(await getPowerView({ slug: guest.slug, paddleNumber: null })).toMatchObject({ viewer: null, committedCents: 0 });
    expect(await getPowerView({ slug: guest.slug, paddleNumber: 99_999 })).toMatchObject({ viewer: null });
    expect(await getPowerView({ slug: "no-such-gala", paddleNumber: 142 })).toBeNull();
  });
});
