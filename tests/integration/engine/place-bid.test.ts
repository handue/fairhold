import { describe, expect, it } from "vitest";

import { openListenConnection } from "@/server/db/client";
import { createLimits, getBiddingPower, placeBid, setMaxBid } from "@/server/engine";
import { EVENT_LOG_CHANNEL, parseEventLogNotification, type EventLogNotification } from "@/server/sse/notify";

import { getTestDatabase } from "../../helpers/database";

import { createEvent, createHold, createLot, createPaddle, expireLot, lotRow } from "./support/fixtures";

const { pool, url } = getTestDatabase();

async function paddleWithHold(eventId: string, number: number, holdCents: number): Promise<string> {
  const paddleId = await createPaddle(pool, eventId, number);
  await createHold(pool, eventId, paddleId, holdCents);
  return paddleId;
}

async function walkUp(lotId: string, paddles: [string, string], fromCents: number, stepCents: number, count: number) {
  for (let index = 0; index < count; index += 1) {
    const bidder = index % 2 === 0 ? paddles[0] : paddles[1];
    const result = await placeBid(bidder, lotId, fromCents + index * stepCents, "bot", { pool });
    expect(result.ok).toBe(true);
  }
}

describe("placeBid on Postgres", () => {
  it("reproduces the approved Jamie story end to end", async () => {
    const eventId = await createEvent(pool);
    const jamie = await paddleWithHold(eventId, 142, 50_000);
    const paddle088 = await paddleWithHold(eventId, 88, 200_000);
    const director = await paddleWithHold(eventId, 31, 200_000);
    const chefsTable = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
    const spaDay = await createLot(pool, eventId, { number: 12, startingBidCents: 7_000, minRaiseCents: 500 });
    await walkUp(chefsTable, [paddle088, director], 10_000, 2_000, 11);
    await walkUp(spaDay, [paddle088, director], 7_000, 500, 4);

    expect(await placeBid(jamie, chefsTable, 32_000, "guest", { pool })).toMatchObject({
      ok: true,
      leading: true,
      lot: { currentBidCents: 32_000, bidCount: 12, nextMinimumCents: 34_000 },
    });
    expect((await getBiddingPower([jamie], pool)).get(jamie)).toMatchObject({
      holdCents: 50_000,
      availableCents: 18_000,
      leftCents: 18_000,
    });

    const plan = await createLimits(jamie, [
      { lotId: chefsTable, maxCents: 38_000 },
      { lotId: spaDay, maxCents: 12_000 },
    ], { pool });
    expect(plan).toMatchObject({ ok: true, bids: [{ lotId: spaDay, amountCents: 9_000, source: "glim" }] });

    const rival = await placeBid(director, chefsTable, 36_000, "bot", { pool });
    expect(rival).toMatchObject({ ok: true, leading: false, proxyBids: [{ paddleId: jamie, amountCents: 38_000 }] });
    expect(await lotRow(pool, chefsTable)).toMatchObject({ current_bid_cents: 38_000, bid_count: 14, high_paddle_id: jamie });

    expect((await getBiddingPower([jamie], pool)).get(jamie)).toEqual({
      paddleId: jamie,
      holdId: expect.any(String),
      holdCents: 50_000,
      committedCents: 50_000,
      availableCents: 0,
      leadingCents: 47_000,
      wonCents: 0,
      reservedCents: 3_000,
      leftCents: 3_000,
    });

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from event_log where paddle_id = $1 and payload->>'kind' = 'limit_raised' order by id desc limit 1",
      [jamie],
    );
    expect(rows[0]?.payload).toMatchObject({
      lotNumber: 7,
      triggerAmountCents: 36_000,
      amountCents: 38_000,
      limitCents: 38_000,
      owner: "glim",
    });
  });

  it("refuses with each typed reason and writes nothing", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 20_000);
    const noHold = await createPaddle(pool, eventId, 143);
    const lotId = await createLot(pool, eventId, { number: 1, startingBidCents: 10_000, minRaiseCents: 1_000 });
    const draft = await createLot(pool, eventId, { number: 2, startingBidCents: 1_000, minRaiseCents: 100, status: "draft" });

    expect(await placeBid(guest, lotId, 9_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "below_minimum", minimumCents: 10_000, amountCents: 9_000 },
    });
    expect(await placeBid(noHold, lotId, 10_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "no_hold", paddleId: noHold },
    });
    expect(await placeBid(guest, lotId, 25_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", holdCents: 20_000, availableCents: 20_000, shortfallCents: 5_000 },
    });
    expect(await placeBid(guest, draft, 1_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "not_open", lotStatus: "draft" },
    });
    const { rows } = await pool.query("select 1 from bids where lot_id = any($1)", [[lotId, draft]]);
    expect(rows).toHaveLength(0);
  });

  it("refuses at closes_at by the database clock before any close has run", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 50_000);
    const lotId = await createLot(pool, eventId, { number: 1, startingBidCents: 10_000, minRaiseCents: 1_000 });
    expect((await placeBid(guest, lotId, 10_000, "guest", { pool })).ok).toBe(true);
    await expireLot(pool, lotId);
    expect(await placeBid(guest, lotId, 11_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "lot_closed", closedAt: null },
    });
    expect(await setMaxBid(guest, lotId, 20_000, { pool })).toMatchObject({ ok: false, refusal: { reason: "lot_closed" } });
    expect((await lotRow(pool, lotId)).status).toBe("open");
  });

  it("notifies each event_log row after commit, in id order", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 50_000);
    const rival = await paddleWithHold(eventId, 88, 50_000);
    const lotId = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
    await placeBid(rival, lotId, 10_000, "guest", { pool });

    const listener = await openListenConnection(url);
    const received: EventLogNotification[] = [];
    listener.on("notification", (message) => {
      const parsed = parseEventLogNotification(message.payload);
      if (message.channel === EVENT_LOG_CHANNEL && parsed?.eventId === eventId) received.push(parsed);
    });
    try {
      await listener.query(`listen ${EVENT_LOG_CHANNEL}`);
      await setMaxBid(guest, lotId, 20_000, { pool });
      await expect.poll(() => received.length).toBe(4);
    } finally {
      await listener.end();
    }

    const { rows } = await pool.query<{ id: string; paddle_id: string | null; type: string; kind: string }>(
      "select id::text, paddle_id, type, payload->>'kind' as kind from event_log where event_id = $1 order by id",
      [eventId],
    );
    const fromThisAction = rows.slice(-received.length);
    expect(received.map((note) => note.id)).toEqual(fromThisAction.map((row) => row.id));
    expect(fromThisAction.map((row) => [row.kind, row.paddle_id])).toEqual([
      ["limit_set", guest],
      ["bids_placed", null],
      ["limit_raised", guest],
      ["outbid", rival],
    ]);
    expect(fromThisAction.map((row) => row.type)).toEqual(["bid", "bid", "bid", "bid"]);
  });
});
