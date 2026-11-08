/**
 * POST .../lots/[number]/bid, /max and /favorite on Postgres: each is bound to the session, comes
 * only from this site, and answers the engine's refusals with their numbers.
 */
import { afterAll, describe, expect, it } from "vitest";

import * as bidRoute from "@/app/api/events/[slug]/lots/[number]/bid/route";
import * as favoriteRoute from "@/app/api/events/[slug]/lots/[number]/favorite/route";
import * as maxRoute from "@/app/api/events/[slug]/lots/[number]/max/route";
import { LOT_ACTIONS_PER_MINUTE } from "@/app/api/events/[slug]/lots/[number]/shared";
import { getBiddingPower, placeBid, setMaxBid } from "@/server/engine";
import { closeStreamHub } from "@/server/sse/hub";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";
import { sessionCookie, slugOf } from "../sse/support";

import { postJson } from "./support";

const { pool } = getTestDatabase();

afterAll(() => closeStreamHub());

async function gala({ eventStatus = "live", holdCents = 50_000 }: { eventStatus?: string; holdCents?: number | null } = {}) {
  const eventId = await createEvent(pool, eventStatus);
  const slug = await slugOf(pool, eventId);
  const lotId = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
  const guest = await createPaddle(pool, eventId, 142);
  const rival = await createPaddle(pool, eventId, 88);
  if (holdCents !== null) await createHold(pool, eventId, guest, holdCents);
  await createHold(pool, eventId, rival, 200_000);
  const cookie = await sessionCookie(pool, slug, { eventId, paddleId: guest });
  return { eventId, slug, lotId, guest, rival, cookie };
}

type Route = { POST: (request: Request, context: never) => Response | Promise<Response> };

function call(route: Route, action: string, slug: string, body: unknown, headers: Record<string, string> = {}, number = "7") {
  const context = { params: Promise.resolve({ slug, number }) };
  return route.POST(postJson(`/api/events/${slug}/lots/${number}/${action}`, body, headers), context as never);
}
const bid = (slug: string, cookie: string, amountCents: unknown, number = "7") =>
  call(bidRoute as Route, "bid", slug, { amountCents }, { cookie }, number);
const max = (slug: string, cookie: string, maxCents: unknown, number = "7") =>
  call(maxRoute as Route, "max", slug, { maxCents }, { cookie }, number);
const favorite = (slug: string, cookie: string, value: unknown, number = "7") =>
  call(favoriteRoute as Route, "favorite", slug, { favorite: value }, { cookie }, number);

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;

const lotState = async (lotId: string) => {
  const { rows } = await pool.query<{ current_bid_cents: number | null; high_paddle_id: string | null; bid_count: number }>(
    "select current_bid_cents, high_paddle_id, bid_count from lots where id = $1",
    [lotId],
  );
  return rows[0];
};

describe("POST .../lots/[number]/bid", () => {
  it("places the guest's bid through the engine", async () => {
    const { slug, lotId, guest, cookie } = await gala();
    const response = await bid(slug, cookie, 12_000);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      bid: { lotId, paddleId: guest, amountCents: 12_000, source: "guest" },
      lot: { number: 7, currentBidCents: 12_000, bidCount: 1, highPaddleId: guest, nextMinimumCents: 14_000 },
      leading: true,
      proxyBids: 0,
    });
    expect(await lotState(lotId)).toMatchObject({ current_bid_cents: 12_000, high_paddle_id: guest, bid_count: 1 });
  });

  it("accepts a zero-padded number, as the page's URL has", async () => {
    const { slug, cookie } = await gala();
    expect((await bid(slug, cookie, 12_000, "07")).status).toBe(200);
  });

  it("says when a rival's max answered at once", async () => {
    const { slug, lotId, rival, cookie } = await gala();
    expect((await setMaxBid(rival, lotId, 30_000, { pool })).ok).toBe(true);

    const response = await bid(slug, cookie, 12_000);
    const body = (await response.json()) as { leading: boolean; proxyBids: number; lot: { currentBidCents: number } };
    expect(body).toMatchObject({ leading: false, proxyBids: 1, lot: { currentBidCents: 14_000 } });
  });

  it("refuses a bid under the next minimum, with the minimum", async () => {
    const { slug, lotId, rival, cookie } = await gala();
    expect((await placeBid(rival, lotId, 32_000, "guest", { pool })).ok).toBe(true);

    const response = await bid(slug, cookie, 33_000);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "below_minimum",
      message: "The next minimum bid is $340.",
      details: { minimumCents: 34_000, amountCents: 33_000 },
    });
  });

  it("refuses a bid past the bidding power, with every number behind it", async () => {
    const { eventId, slug, lotId, cookie, guest } = await gala();
    const elsewhere = await createLot(pool, eventId, { number: 9, startingBidCents: 32_000, minRaiseCents: 1_000 });
    expect((await placeBid(guest, elsewhere, 32_000, "guest", { pool })).ok).toBe(true);

    const response = await bid(slug, cookie, 20_000);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({
      code: "over_bidding_power",
      message: "This needs $200, and you have $180 left of $500.",
      details: {
        holdCents: 50_000,
        committedElsewhereCents: 32_000,
        availableCents: 18_000,
        requiredCents: 20_000,
        shortfallCents: 2_000,
        lotIds: [lotId],
      },
    });
    expect(await lotState(lotId)).toMatchObject({ current_bid_cents: null });
  });

  it("refuses with no bidding power set", async () => {
    const { slug, cookie } = await gala({ holdCents: null });
    const response = await bid(slug, cookie, 12_000);
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: "no_hold", message: "Set your bidding power before you bid." });
  });

  it("refuses on a closed lot and before the event opens", async () => {
    const closed = await gala();
    await pool.query("update lots set status = 'closed' where id = $1", [closed.lotId]);
    const afterClose = await bid(closed.slug, closed.cookie, 12_000);
    expect(afterClose.status).toBe(409);
    expect(await errorOf(afterClose)).toMatchObject({ code: "lot_closed", message: "Bidding on this lot has closed." });

    const early = await gala({ eventStatus: "scheduled" });
    const beforeOpen = await bid(early.slug, early.cookie, 12_000);
    expect(beforeOpen.status).toBe(409);
    expect(await errorOf(beforeOpen)).toMatchObject({ code: "not_open", message: "This lot isn’t open for bids yet." });
  });

  it("refuses without a session, or with another event's", async () => {
    const { slug } = await gala();
    const other = await gala();
    for (const cookie of ["", other.cookie]) {
      const response = await bid(slug, cookie, 12_000);
      expect(response.status).toBe(401);
      expect(await errorOf(response)).toMatchObject({ code: "not_joined" });
    }
  });

  it("refuses an organizer with no paddle", async () => {
    const { eventId, slug } = await gala();
    const cookie = await sessionCookie(pool, slug, { eventId, paddleId: null, isOrganizer: true });
    expect((await bid(slug, cookie, 12_000)).status).toBe(401);
  });

  it("refuses a request from another site, session or not", async () => {
    const { slug, lotId, cookie } = await gala();
    const response = await call(bidRoute as Route, "bid", slug, { amountCents: 12_000 }, { cookie, origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toMatchObject({ code: "cross_origin" });
    expect(await lotState(lotId)).toMatchObject({ current_bid_cents: null });
  });

  it("answers 404 for a lot that does not exist, is a draft, or belongs to another event", async () => {
    const { eventId, slug, cookie } = await gala();
    await createLot(pool, eventId, { number: 8, startingBidCents: 1_000, minRaiseCents: 100, status: "draft" });
    const other = await gala();
    await createLot(pool, other.eventId, { number: 21, startingBidCents: 1_000, minRaiseCents: 100 });
    for (const number of ["99", "8", "21", "abc", "0"]) {
      const response = await bid(slug, cookie, 12_000, number);
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toMatchObject({ code: "lot_not_found" });
    }
  });

  it("refuses amounts that are not whole, positive cents", async () => {
    const { slug, cookie } = await gala();
    for (const amount of [0, -100, 12_000.5, "12000", null, 2_147_483_648]) {
      const response = await bid(slug, cookie, amount);
      expect(response.status).toBe(400);
      expect(await errorOf(response)).toMatchObject({ code: "invalid_request" });
    }
  });

  it("takes POST only", () => {
    for (const route of [bidRoute, maxRoute, favoriteRoute]) expect(Object.keys(route)).toEqual(["POST"]);
  });

  it("brakes a script, per paddle", async () => {
    const { eventId, slug, cookie } = await gala();
    const bystander = await createPaddle(pool, eventId, 90);
    const bystanderCookie = await sessionCookie(pool, slug, { eventId, paddleId: bystander });
    await pool.query(
      `insert into rate_limits (key, window_start, count)
       select 'lot-action:' || p.id, to_timestamp(floor(extract(epoch from now()) / $1::int) * $1::int), $2::int
       from paddles p join sessions s on s.paddle_id = p.id where p.event_id = $3 and p.number = 142`,
      [LOT_ACTIONS_PER_MINUTE.windowSeconds, LOT_ACTIONS_PER_MINUTE.limit, eventId],
    );

    const response = await bid(slug, cookie, 12_000);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await errorOf(response)).toMatchObject({ code: "rate_limited" });

    // No hold, but past the brake: the refusal comes from the engine.
    expect((await errorOf(await bid(slug, bystanderCookie, 12_000))).code).toBe("no_hold");
  });
});

describe("POST .../lots/[number]/max", () => {
  it("sets a guest max and bids at once where the guest is not leading", async () => {
    const { slug, lotId, guest, cookie } = await gala();
    const response = await max(slug, cookie, 30_000);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      limit: { lotId, paddleId: guest, maxCents: 30_000, owner: "guest_max", active: true },
      lot: { currentBidCents: 10_000, highPaddleId: guest },
      leading: true,
      bids: 1,
    });
    const power = await getBiddingPower([guest], pool);
    expect(power.get(guest)).toMatchObject({ holdCents: 50_000, committedCents: 30_000, availableCents: 20_000 });
  });

  it("answers a rival by the minimum raise, up to the max", async () => {
    const { slug, lotId, rival, cookie, guest } = await gala();
    expect((await max(slug, cookie, 30_000)).status).toBe(200);
    expect((await placeBid(rival, lotId, 20_000, "guest", { pool })).ok).toBe(true);
    expect(await lotState(lotId)).toMatchObject({ current_bid_cents: 22_000, high_paddle_id: guest });
  });

  it("refuses a max past the bidding power, with the numbers, and under the minimum", async () => {
    const { slug, lotId, rival, cookie } = await gala();
    const tooHigh = await max(slug, cookie, 60_000);
    expect(tooHigh.status).toBe(409);
    expect(await errorOf(tooHigh)).toMatchObject({
      code: "over_bidding_power",
      message: "This needs $600, and you have $500 left of $500.",
      details: { requiredCents: 60_000, availableCents: 50_000, shortfallCents: 10_000 },
    });

    expect((await placeBid(rival, lotId, 32_000, "guest", { pool })).ok).toBe(true);
    const tooLow = await max(slug, cookie, 33_000);
    expect(tooLow.status).toBe(409);
    expect(await errorOf(tooLow)).toMatchObject({ code: "below_minimum", details: { minimumCents: 34_000 } });
  });

  it("is bound to the session and to this site, like the bid", async () => {
    const { slug, lotId, cookie } = await gala();
    expect((await max(slug, "", 30_000)).status).toBe(401);
    const crossSite = await call(maxRoute as Route, "max", slug, { maxCents: 30_000 }, { cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await lotState(lotId)).toMatchObject({ current_bid_cents: null });
  });

  it("refuses amounts that are not whole, positive cents", async () => {
    const { slug, cookie } = await gala();
    for (const amount of [0, 100.5, "30000"]) expect((await max(slug, cookie, amount)).status).toBe(400);
  });
});

describe("POST .../lots/[number]/favorite", () => {
  const hearted = async (paddleId: string, lotId: string) =>
    (await pool.query("select 1 from favorites where paddle_id = $1 and lot_id = $2", [paddleId, lotId])).rowCount === 1;
  const rows = async (eventId: string) =>
    (
      await pool.query<{ paddle_id: string; type: string; payload: { kind: string; isFavorite: boolean; lotNumber: number } }>(
        "select paddle_id, type, payload from event_log where event_id = $1 and payload->>'kind' = 'favorite_changed' order by id",
        [eventId],
      )
    ).rows;

  it("sets and clears the heart, on the guest's own channel", async () => {
    const { eventId, slug, lotId, guest, cookie } = await gala();

    const set = await favorite(slug, cookie, true);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ favorite: true });
    expect(await hearted(guest, lotId)).toBe(true);

    expect(await (await favorite(slug, cookie, false)).json()).toEqual({ favorite: false });
    expect(await hearted(guest, lotId)).toBe(false);

    expect((await rows(eventId)).map((row) => [row.paddle_id, row.type, row.payload.isFavorite, row.payload.lotNumber])).toEqual([
      [guest, "bid", true, 7],
      [guest, "bid", false, 7],
    ]);
  });

  it("lands on the value asked for however often it is sent, with one row per change", async () => {
    const { eventId, slug, lotId, guest, cookie } = await gala();
    expect((await favorite(slug, cookie, true)).status).toBe(200);
    expect((await favorite(slug, cookie, true)).status).toBe(200);
    expect(await hearted(guest, lotId)).toBe(true);
    expect(await rows(eventId)).toHaveLength(1);

    expect((await favorite(slug, cookie, false)).status).toBe(200);
    expect((await favorite(slug, cookie, false)).status).toBe(200);
    expect(await hearted(guest, lotId)).toBe(false);
    expect(await rows(eventId)).toHaveLength(2);
  });

  it("can heart a closed lot, and never a lot of another event", async () => {
    const { slug, lotId, guest, cookie } = await gala();
    await pool.query("update lots set status = 'closed' where id = $1", [lotId]);
    expect((await favorite(slug, cookie, true)).status).toBe(200);
    expect(await hearted(guest, lotId)).toBe(true);

    const other = await gala();
    await createLot(pool, other.eventId, { number: 21, startingBidCents: 1_000, minRaiseCents: 100 });
    expect((await favorite(slug, cookie, true, "21")).status).toBe(404);
  });

  it("is bound to the session and to this site", async () => {
    const { slug, lotId, guest, cookie } = await gala();
    expect((await favorite(slug, "", true)).status).toBe(401);
    const crossSite = await call(favoriteRoute as Route, "favorite", slug, { favorite: true }, { cookie, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await hearted(guest, lotId)).toBe(false);
  });

  it("takes a value, not a flip", async () => {
    const { slug, cookie } = await gala();
    for (const value of [1, "true", null, undefined]) expect((await favorite(slug, cookie, value)).status).toBe(400);
  });
});
