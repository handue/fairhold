/**
 * /api/stream on Postgres, through the route, with real bids: how fast a bid reaches another browser,
 * who receives what, and how a browser picks up where it left off.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { POST as placeBidRoute } from "@/app/api/events/[slug]/lots/[number]/bid/route";
import { GET as pollRoute } from "@/app/api/stream/poll/route";
import { GET } from "@/app/api/stream/route";
import { MAX_STREAMS_PER_CLIENT } from "@/server/sse/client-streams";
import { closeStreamHub, getStreamHub, STREAM_LISTENER_NAME } from "@/server/sse/hub";
import { appendEventLog } from "@/server/sse/notify";
import { placeBid, setMaxBid } from "@/server/engine";
import {
  STREAM_RECENT_ROWS,
  STREAM_REPLAY_LIMIT,
  type StreamControlPayloads,
  type StreamEvent,
  type StreamPollResponse,
} from "@/server/sse/types";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";

import { isRow, openStream, rowOf, sessionCookie, slugOf, until, type Frame, type StreamReader } from "./support";

const { pool } = getTestDatabase();

/** A gala with two lots and two real guests in browsers of their own, each holding $1,000. */
async function gala({ holdCents = 100_000 } = {}) {
  const eventId = await createEvent(pool);
  const slug = await slugOf(pool, eventId);
  const lotId = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
  const secondLotId = await createLot(pool, eventId, { number: 9, startingBidCents: 5_000, minRaiseCents: 1_000 });
  const ana = await createPaddle(pool, eventId, 142);
  const ben = await createPaddle(pool, eventId, 88);
  await createHold(pool, eventId, ana, holdCents);
  await createHold(pool, eventId, ben, holdCents);
  const anaCookie = await sessionCookie(pool, slug, { eventId, paddleId: ana });
  const benCookie = await sessionCookie(pool, slug, { eventId, paddleId: ben });
  return { eventId, slug, lotId, secondLotId, ana, ben, anaCookie, benCookie };
}

const open: StreamReader[] = [];
async function follow(...args: Parameters<typeof openStream>): Promise<StreamReader> {
  const reader = await openStream(...args);
  open.push(reader);
  return reader.ready();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((reader) => reader.close()));
});

afterAll(async () => {
  await closeStreamHub();
});

const bidFrame = (cents: number) => (frame: Frame) =>
  frame.event === "bid" && (rowOf(frame).payload as { kind?: string; currentBidCents?: number }).kind === "bids_placed" &&
  (rowOf(frame).payload as { currentBidCents?: number }).currentBidCents === cents;

const kinds = (reader: StreamReader) => reader.rows.map((row) => (row.payload as { kind?: string }).kind);

describe("GET /api/stream", () => {
  it("answers as an event stream nothing along the way may buffer or compress", async () => {
    const { slug } = await gala();
    const reader = await follow({ slug });
    expect(reader.response.status).toBe(200);
    expect(reader.response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(reader.response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(reader.response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("says hello first, with who it speaks for and the server's clock", async () => {
    const { slug, ana, anaCookie } = await gala();
    const before = Date.now();
    const reader = await follow({ slug, cookie: anaCookie });
    expect(reader.frames[0]?.event).toBe("hello");
    const hello = reader.frames[0]?.data as StreamControlPayloads["hello"];
    expect(hello).toMatchObject({ paddleId: ana, paddleNumber: 142, isOrganizer: false });
    expect(hello.serverNow).toBeGreaterThanOrEqual(before - 5_000);
    expect(hello.serverNow).toBeLessThanOrEqual(Date.now() + 5_000);
  });

  it("reads the frozen clock the pages read", async () => {
    const { slug } = await gala();
    vi.stubEnv("FREEZE_CLOCK_AT", "2026-11-09T04:58:00.000Z");
    const reader = await follow({ slug });
    expect(reader.hello.serverNow).toBe(Date.parse("2026-11-09T04:58:00.000Z"));
  });

  it("answers 400 with no slug and 404 for an unknown event, so a browser stops asking", async () => {
    const { GET } = await import("@/app/api/stream/route");
    const missing = await GET(new Request("https://fairhold.example/api/stream"), undefined);
    expect(missing.status).toBe(400);
    const unknown = await GET(new Request("https://fairhold.example/api/stream?slug=no-such-gala"), undefined);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "event_not_found" } });
  });

  it("does not hold a connection open for reuse, so a shutting-down server can exit", async () => {
    const { slug } = await gala();
    const reader = await follow({ slug });
    expect(reader.response.headers.get("connection")).toBe("close");
  });

  it("refuses new streams while the process shuts down, and ends the open ones", async () => {
    const { slug } = await gala();
    const reader = await follow({ slug });
    const hub = getStreamHub();
    await hub.close();
    expect(hub.isClosed).toBe(true);
    await reader.untilEnded();

    const { GET } = await import("@/app/api/stream/route");
    const response = await GET(new Request(`https://fairhold.example/api/stream?slug=${slug}`), undefined);
    expect(response.status).toBe(503);
    expect(response.headers.get("connection")).toBe("close");
    expect(await response.json()).toMatchObject({ error: { code: "stream_closed" } });
    await closeStreamHub();
  });

  it("frees the stream when the browser goes away", async () => {
    const { slug } = await gala();
    const before = getStreamHub().subscriberCount;
    const reader = await follow({ slug });
    expect(getStreamHub().subscriberCount).toBe(before + 1);
    await reader.close();
    open.splice(open.indexOf(reader), 1);
    expect(reader.ended).toBe(true);
    await until(() => getStreamHub().subscriberCount === before);
  });
});

describe("streams from one address", () => {
  const CLIENT = { "x-forwarded-for": "203.0.113.31" };

  async function openFrom(slug: string, headers: Record<string, string>) {
    const controller = new AbortController();
    const response = await GET(new Request(`https://fairhold.example/api/stream?slug=${slug}`, { headers, signal: controller.signal }), undefined);
    return { response, close: () => controller.abort() };
  }

  it("stop at the limit with 429, leave other addresses alone, and come back as streams close", async () => {
    const { slug } = await gala();
    const held = await Promise.all(Array.from({ length: MAX_STREAMS_PER_CLIENT }, () => openFrom(slug, CLIENT)));
    try {
      expect(held.map(({ response }) => response.status)).toEqual(held.map(() => 200));

      const refused = await openFrom(slug, CLIENT);
      expect(refused.response.status).toBe(429);
      expect(refused.response.headers.get("retry-after")).toBe("30");
      expect(await refused.response.json()).toMatchObject({ error: { code: "too_many_streams" } });

      const other = await openFrom(slug, { "x-forwarded-for": "203.0.113.32" });
      expect(other.response.status).toBe(200);
      other.close();

      held[0]?.close();
      const again = await openFrom(slug, CLIENT);
      expect(again.response.status).toBe(200);
      again.close();
    } finally {
      for (const { close } of held) close();
    }
    // Every slot came back, however each stream ended.
    const after = await Promise.all(Array.from({ length: MAX_STREAMS_PER_CLIENT }, () => openFrom(slug, CLIENT)));
    expect(after.map(({ response }) => response.status)).toEqual(after.map(() => 200));
    for (const { close } of after) close();
  });

  it("do not count for a request that was refused before it opened", async () => {
    const before = await openFrom("no-such-event", CLIENT);
    expect(before.response.status).toBe(404);
    const { slug } = await gala();
    const held = await Promise.all(Array.from({ length: MAX_STREAMS_PER_CLIENT }, () => openFrom(slug, CLIENT)));
    expect(held.every(({ response }) => response.status === 200)).toBe(true);
    for (const { close } of held) close();
  });
});

describe("a bid in one browser", () => {
  it("reaches a second browser within a second, through the route, on Postgres", async () => {
    const { slug, ana, anaCookie, benCookie } = await gala();
    const second = await follow({ slug, cookie: benCookie });
    const first = await follow({ slug, cookie: anaCookie });

    const startedAt = performance.now();
    const response = await placeBidRoute(
      postJson(`/api/events/${slug}/lots/7/bid`, { amountCents: 32_000 }, { cookie: anaCookie }),
      { params: Promise.resolve({ slug, number: "7" }) },
    );
    expect(response.status).toBe(200);
    const frame = await second.waitFor(bidFrame(32_000), 1_000);
    const elapsed = performance.now() - startedAt;

    expect(elapsed).toBeLessThan(1_000);
    expect(rowOf(frame)).toMatchObject({
      type: "bid",
      paddleId: null,
      payload: { lotNumber: 7, bidCount: 1, highPaddleId: ana, highPaddleNumber: 142, nextMinimumCents: 34_000 },
    });
    await first.waitFor(bidFrame(32_000), 1_000);
  });

  it("reaches every viewer once, in order, with the row's id as its SSE id", async () => {
    const { slug, lotId, ana, anaCookie, benCookie } = await gala();
    const readers = [await follow({ slug }), await follow({ slug, cookie: benCookie }), await follow({ slug, cookie: anaCookie })];
    for (const cents of [32_000, 34_000, 36_000]) {
      const placed = await placeBid(ana, lotId, cents, "guest", { pool });
      expect(placed.ok).toBe(true);
    }
    for (const reader of readers) {
      await reader.waitFor(bidFrame(36_000));
      const placedRows = reader.frames.filter((frame) => frame.id !== null && (rowOf(frame).payload as { kind?: string }).kind === "bids_placed");
      expect(placedRows.map((frame) => (rowOf(frame).payload as { currentBidCents: number }).currentBidCents)).toEqual([32_000, 34_000, 36_000]);
      for (const frame of placedRows) expect(frame.id).toBe(rowOf(frame).id);
    }
  });
});

describe("who receives what", () => {
  it("never gives a guest another paddle's private rows", async () => {
    const { eventId, slug, lotId, ana, ben, anaCookie, benCookie } = await gala();
    const anaStream = await follow({ slug, cookie: anaCookie });
    const benStream = await follow({ slug, cookie: benCookie });
    const visitor = await follow({ slug });

    // Ana's max answers Ben's bids: private limit rows and outbid news on both sides.
    expect((await setMaxBid(ana, lotId, 40_000, { pool })).ok).toBe(true);
    expect((await placeBid(ben, lotId, 20_000, "guest", { pool })).ok).toBe(true);
    expect((await placeBid(ben, lotId, 50_000, "guest", { pool })).ok).toBe(true);
    await appendEventLog(pool, [
      { eventId, paddleId: ana, type: "hold", payload: { holdId: "h1", status: "authorized", amountCents: 1 } },
      { eventId, paddleId: ana, type: "glim", payload: { kind: "chat_card", chatMessageId: "m1", actionId: null } },
      { eventId, paddleId: ana, type: "settlement", payload: { kind: "settlement_item", itemId: "s1" } },
    ]);
    const marker = await appendEventLog(pool, [{ eventId, paddleId: null, type: "event_status", payload: { kind: "event_settled", status: "settled" } }]);
    const end = (frame: Frame) => frame.id === marker[0]?.id;
    await Promise.all([anaStream.waitFor(end), benStream.waitFor(end), visitor.waitFor(end)]);

    for (const row of anaStream.rows) expect([null, ana]).toContain(row.paddleId);
    for (const row of benStream.rows) expect([null, ben]).toContain(row.paddleId);
    for (const row of visitor.rows) expect(row.paddleId).toBeNull();

    expect(kinds(anaStream)).toEqual(expect.arrayContaining(["limit_set", "limit_raised", "limit_exhausted", "outbid", "chat_card", "settlement_item"]));
    expect(anaStream.rows.some((row) => row.type === "hold")).toBe(true);
    expect(kinds(benStream)).toContain("outbid");
    expect(kinds(benStream)).not.toContain("limit_set");
    expect(benStream.rows.some((row) => row.type === "hold" || row.type === "settlement")).toBe(false);
  });

  it("gives an organizer every paddle's holds and settlement items, and none of its Glim or bid news", async () => {
    const { eventId, slug, lotId, ana } = await gala();
    const organizer = await follow({ slug, cookie: await sessionCookie(pool, slug, { eventId, paddleId: null, isOrganizer: true }) });
    expect(organizer.hello).toMatchObject({ isOrganizer: true, paddleId: null, paddleNumber: null });

    expect((await setMaxBid(ana, lotId, 40_000, { pool })).ok).toBe(true);
    const logged = await appendEventLog(pool, [
      { eventId, paddleId: ana, type: "hold", payload: { holdId: "h1", status: "voided" } },
      { eventId, paddleId: ana, type: "settlement", payload: { kind: "settlement_item", itemId: "s1" } },
      { eventId, paddleId: ana, type: "glim", payload: { kind: "chat_card", chatMessageId: "m1", actionId: null } },
      { eventId, paddleId: null, type: "event_status", payload: { kind: "event_settled", status: "settled" } },
    ]);
    await organizer.waitFor((frame) => frame.id === logged.at(-1)?.id);

    const others = organizer.rows.filter((row) => row.paddleId !== null);
    expect(others.map((row) => row.type).sort()).toEqual(["hold", "settlement"]);
  });

  it("gives a session's own paddle no matter what the address asks for, in production", async () => {
    const { slug, lotId, ana, ben, anaCookie } = await gala();
    vi.stubEnv("NODE_ENV", "production");
    const asksForBen = await follow({ slug, cookie: anaCookie, paddle: 88 });
    const noSession = await follow({ slug, paddle: 88 });
    expect(asksForBen.hello).toMatchObject({ paddleId: ana, paddleNumber: 142 });
    expect(noSession.hello).toMatchObject({ paddleId: null, paddleNumber: null, isOrganizer: false });

    expect((await setMaxBid(ben, lotId, 40_000, { pool })).ok).toBe(true);
    await asksForBen.waitFor(bidFrame(10_000));
    await noSession.waitFor(bidFrame(10_000));
    expect(asksForBen.rows.some((row) => row.paddleId === ben)).toBe(false);
    expect(noSession.rows.some((row) => row.paddleId !== null)).toBe(false);
  });

  it("follows the page's ?paddle= outside production, so a chosen viewer gets its rows", async () => {
    const { slug, ben } = await gala();
    const reader = await follow({ slug, paddle: 88 });
    expect(reader.hello).toMatchObject({ paddleId: ben, paddleNumber: 88 });
  });
});

describe("picking up after a drop", () => {
  it("replays what was missed after Last-Event-ID, then carries on live", async () => {
    const { slug, lotId, ana, anaCookie } = await gala();
    const first = await follow({ slug, cookie: anaCookie });
    expect((await placeBid(ana, lotId, 32_000, "guest", { pool })).ok).toBe(true);
    const last = (await first.waitFor(bidFrame(32_000))).id ?? "";
    await first.close();
    open.splice(open.indexOf(first), 1);

    expect((await placeBid(ana, lotId, 34_000, "guest", { pool })).ok).toBe(true);
    const resumed = await follow({ slug, cookie: anaCookie, lastEventId: last });
    await resumed.waitFor(bidFrame(34_000));
    expect(resumed.rows.every((row) => BigInt(row.id) > BigInt(last))).toBe(true);
    expect(resumed.hello.after).toBe(last);

    expect((await placeBid(ana, lotId, 36_000, "guest", { pool })).ok).toBe(true);
    await resumed.waitFor(bidFrame(36_000));
    expect(resumed.frames.filter(bidFrame(32_000))).toHaveLength(0);
    expect(resumed.frames.filter(bidFrame(34_000))).toHaveLength(1);
  });

  it("takes ?after= the same way, and Last-Event-ID over it, as a browser's own retry would send both", async () => {
    const { slug, lotId, ana } = await gala();
    expect((await placeBid(ana, lotId, 32_000, "guest", { pool })).ok).toBe(true);
    const firstRows = await follow({ slug, after: "0" });
    const first = await firstRows.waitFor(bidFrame(32_000));
    expect((await placeBid(ana, lotId, 34_000, "guest", { pool })).ok).toBe(true);
    await firstRows.waitFor(bidFrame(34_000));

    const fromAfter = await follow({ slug, after: first.id ?? "" });
    await fromAfter.waitFor(bidFrame(34_000));
    expect(fromAfter.frames.filter(bidFrame(32_000))).toHaveLength(0);

    const headerWins = await follow({ slug, after: "0", lastEventId: first.id ?? "" });
    await headerWins.waitFor(bidFrame(34_000));
    expect(headerWins.frames.filter(bidFrame(32_000))).toHaveLength(0);
  });

  it("ignores a position that is not one", async () => {
    const { slug, lotId, ana } = await gala();
    expect((await placeBid(ana, lotId, 32_000, "guest", { pool })).ok).toBe(true);
    const reader = await follow({ slug, after: "1 or 1=1" });
    await reader.waitFor(bidFrame(32_000));
  });

  it("starts a new connection a few rows behind, so a page that just rendered misses nothing", async () => {
    const { eventId, slug } = await gala();
    const written = await appendEventLog(
      pool,
      Array.from({ length: STREAM_RECENT_ROWS + 20 }, () => ({
        eventId,
        paddleId: null,
        type: "event_status" as const,
        payload: { kind: "event_settled", status: "settled" },
      })),
    );
    const reader = await follow({ slug });
    await reader.waitFor((frame) => frame.id === written.at(-1)?.id);
    expect(reader.rows).toHaveLength(STREAM_RECENT_ROWS);
    expect(reader.rows[0]?.id).toBe(written[20]?.id);
    expect(reader.hello.after).toBe(written[19]?.id);
    expect(reader.hello.latest).toBe(written.at(-1)?.id);
  });

  it("sends resync to a client too far behind, then carries on from there", async () => {
    const { eventId, slug, lotId, ana } = await gala();
    const before = await appendEventLog(pool, [{ eventId, paddleId: null, type: "event_status", payload: { kind: "event_settled", status: "settled" } }]);
    const written = await appendEventLog(
      pool,
      Array.from({ length: STREAM_REPLAY_LIMIT + 1 }, () => ({
        eventId,
        paddleId: null,
        type: "event_status" as const,
        payload: { kind: "event_settled", status: "settled" },
      })),
    );
    const reader = await follow({ slug, lastEventId: before[0]?.id ?? "" });
    const resync = await reader.waitFor((frame) => frame.event === "resync");
    expect(resync.id).toBeNull();
    expect(resync.data).toEqual({ reason: "too_far_behind", position: written.at(-1)?.id });
    expect(reader.frames.filter(isRow)).toHaveLength(0);

    expect((await placeBid(ana, lotId, 32_000, "guest", { pool })).ok).toBe(true);
    await reader.waitFor(bidFrame(32_000));
  });

  it("replays exactly up to the limit without a resync", async () => {
    const { eventId, slug } = await gala();
    const start = await appendEventLog(pool, [{ eventId, paddleId: null, type: "event_status", payload: { kind: "event_settled", status: "settled" } }]);
    const written = await appendEventLog(
      pool,
      Array.from({ length: STREAM_REPLAY_LIMIT }, () => ({
        eventId,
        paddleId: null,
        type: "event_status" as const,
        payload: { kind: "event_settled", status: "settled" },
      })),
    );
    const reader = await follow({ slug, lastEventId: start[0]?.id ?? "" });
    await reader.waitFor((frame) => frame.id === written.at(-1)?.id, 5_000);
    expect(reader.rows).toHaveLength(STREAM_REPLAY_LIMIT);
    expect(reader.frames.some((frame) => frame.event === "resync")).toBe(false);
  });
});

describe("under load", () => {
  it("loses nothing, repeats nothing and keeps order for a stream that joins in the middle of the bidding", async () => {
    const { eventId, slug, lotId, secondLotId, ana, ben, anaCookie, benCookie } = await gala({ holdCents: 100_000_000 });
    const early = await follow({ slug, cookie: anaCookie });

    const bids = Array.from({ length: 40 }, (_, index) =>
      placeBid(index % 2 === 0 ? ana : ben, index % 3 === 0 ? secondLotId : lotId, 200_000 + index * 2_000, "guest", { pool }),
    );
    const late = await openStream({ slug, cookie: benCookie, after: early.hello.latest });
    open.push(late);
    const results = await Promise.all(bids);
    expect(results.filter((result) => result.ok).length).toBeGreaterThan(1);

    const expected = async (paddleId: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `select id::text as id from event_log
         where event_id = $1 and id > $2::bigint and (paddle_id is null or paddle_id = $3) order by id`,
        [eventId, early.hello.latest, paddleId],
      );
      return rows.map((row) => row.id);
    };
    const anaRows = await expected(ana);
    const benRows = await expected(ben);
    await early.waitFor((frame) => frame.id === anaRows.at(-1), 5_000);
    await late.waitFor((frame) => frame.id === benRows.at(-1), 5_000);

    expect(early.rows.map((row) => row.id)).toEqual(anaRows);
    expect(late.rows.map((row) => row.id)).toEqual(benRows);
  });

  it("holds one LISTEN connection however many streams and events are open", async () => {
    const one = await gala();
    const two = await gala();
    await follow({ slug: one.slug });
    await follow({ slug: one.slug, cookie: one.anaCookie });
    await follow({ slug: one.slug, cookie: one.benCookie });
    await follow({ slug: two.slug });
    await follow({ slug: two.slug, cookie: two.anaCookie });

    const { rows } = await pool.query<{ count: number }>(
      "select count(*)::int as count from pg_stat_activity where application_name = $1 and datname = current_database()",
      [STREAM_LISTENER_NAME],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it("keeps two events' rows apart", async () => {
    const one = await gala();
    const two = await gala();
    const first = await follow({ slug: one.slug });
    const second = await follow({ slug: two.slug });
    expect((await placeBid(one.ana, one.lotId, 32_000, "guest", { pool })).ok).toBe(true);
    expect((await placeBid(two.ana, two.lotId, 36_000, "guest", { pool })).ok).toBe(true);
    await first.waitFor(bidFrame(32_000));
    await second.waitFor(bidFrame(36_000));
    expect(first.frames.filter(bidFrame(36_000))).toHaveLength(0);
    expect(second.frames.filter(bidFrame(32_000))).toHaveLength(0);
  });
});

describe("GET /api/stream/poll", () => {
  const poll = (slug: string, query: { after?: string; cookie?: string } = {}) => {
    const url = new URL("https://fairhold.example/api/stream/poll");
    url.searchParams.set("slug", slug);
    if (query.after) url.searchParams.set("after", query.after);
    return pollRoute(new Request(url, { headers: query.cookie ? { cookie: query.cookie } : {} }), undefined);
  };
  const body = async (response: Response) => (await response.json()) as StreamPollResponse;

  it("answers 404 for an unknown event, which is how a refused stream learns why", async () => {
    const response = await poll("no-such-gala");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "event_not_found" } });
  });

  it("gives the same rows as the stream, to the same viewer, and where to ask from next", async () => {
    const { slug, lotId, ana, ben, anaCookie, benCookie } = await gala();
    const before = await body(await poll(slug, { cookie: anaCookie }));
    expect(before).toMatchObject({ rows: [], resync: false, after: "0", position: "0" });

    expect((await setMaxBid(ana, lotId, 40_000, { pool })).ok).toBe(true);
    expect((await placeBid(ben, lotId, 20_000, "guest", { pool })).ok).toBe(true);

    const seenByAna = await body(await poll(slug, { after: before.position, cookie: anaCookie }));
    const seenByBen = await body(await poll(slug, { after: before.position, cookie: benCookie }));
    const seenByVisitor = await body(await poll(slug, { after: before.position }));
    expect(seenByAna.rows.some((row: StreamEvent) => row.paddleId === ana)).toBe(true);
    for (const row of seenByAna.rows) expect([null, ana]).toContain(row.paddleId);
    for (const row of seenByBen.rows) expect([null, ben]).toContain(row.paddleId);
    for (const row of seenByVisitor.rows) expect(row.paddleId).toBeNull();

    const stream = await follow({ slug, cookie: anaCookie, after: before.position });
    await stream.waitFor((frame) => frame.id === seenByAna.rows.at(-1)?.id);
    expect(stream.rows).toEqual(seenByAna.rows);

    const next = await body(await poll(slug, { after: seenByAna.position, cookie: anaCookie }));
    expect(next).toMatchObject({ rows: [], position: seenByAna.position });
  });

  it("says resync for a client too far behind", async () => {
    const { eventId, slug } = await gala();
    await appendEventLog(pool, [{ eventId, paddleId: null, type: "event_status", payload: { kind: "event_settled", status: "settled" } }]);
    const written = await appendEventLog(
      pool,
      Array.from({ length: STREAM_REPLAY_LIMIT + 1 }, () => ({
        eventId,
        paddleId: null,
        type: "event_status" as const,
        payload: { kind: "event_settled", status: "settled" },
      })),
    );
    const answer = await body(await poll(slug, { after: "1" }));
    expect(answer).toMatchObject({ rows: [], resync: true, position: written.at(-1)?.id });
  });
});
