import { describe, expect, it } from "vitest";

import { closeDueLots, closeEvent, createLimits, getBiddingPower, placeBid, setMaxBid } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";

import { createEvent, createHold, createLot, createPaddle, expireLot, lotRow } from "./support/fixtures";

const { pool } = getTestDatabase();

async function paddleWithHold(eventId: string, number: number, holdCents: number): Promise<string> {
  const paddleId = await createPaddle(pool, eventId, number);
  await createHold(pool, eventId, paddleId, holdCents);
  return paddleId;
}

async function eventStatus(eventId: string): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>("select status from events where id = $1", [eventId]);
  return rows[0]?.status;
}

describe("closing on Postgres", () => {
  it("closes due lots with their winners, ends their limits, then closes the event", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 50_000);
    const rival = await paddleWithHold(eventId, 88, 50_000);
    const first = await createLot(pool, eventId, { number: 1, startingBidCents: 10_000, minRaiseCents: 2_000 });
    const second = await createLot(pool, eventId, { number: 2, startingBidCents: 5_000, minRaiseCents: 1_000 });
    await setMaxBid(guest, first, 30_000, { pool });
    await placeBid(rival, first, 20_000, "guest", { pool });
    await expireLot(pool, first);

    const firstPass = await closeDueLots(undefined, { pool });
    expect(firstPass.closedLots).toEqual([
      expect.objectContaining({ lotId: first, eventId, winningPaddleId: guest, winningCents: 22_000, bidCount: 3 }),
    ]);
    expect(firstPass.closedEventIds).toEqual([]);
    const closed = await lotRow(pool, first);
    expect(closed).toMatchObject({ status: "closed", winning_paddle_id: guest, winning_cents: 22_000 });
    expect(closed.closed_at).toBeInstanceOf(Date);
    const { rows: limits } = await pool.query<{ active: boolean; ended_at: Date | null }>(
      "select active, ended_at from bid_limits where lot_id = $1",
      [first],
    );
    expect(limits).toEqual([{ active: false, ended_at: expect.any(Date) }]);
    expect((await getBiddingPower([guest], pool)).get(guest)).toMatchObject({ committedCents: 22_000, wonCents: 22_000 });
    expect(await eventStatus(eventId)).toBe("live");

    await expireLot(pool, second);
    expect(await closeDueLots(undefined, { pool })).toEqual({
      closedLots: [expect.objectContaining({ lotId: second, winningPaddleId: null, winningCents: null })],
      closedEventIds: [eventId],
    });
    expect(await eventStatus(eventId)).toBe("closed");
    expect(await closeDueLots(undefined, { pool })).toEqual({ closedLots: [], closedEventIds: [] });
  });

  it("closes each lot exactly once when closers race", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 50_000);
    const lots: string[] = [];
    for (let number = 1; number <= 6; number += 1) {
      const lotId = await createLot(pool, eventId, { number, startingBidCents: 1_000, minRaiseCents: 100 });
      await placeBid(guest, lotId, 1_000, "guest", { pool });
      await expireLot(pool, lotId);
      lots.push(lotId);
    }
    const passes = await Promise.all([
      closeDueLots(undefined, { pool }),
      closeDueLots(undefined, { pool }),
      closeEvent(eventId, { pool }),
    ]);
    const closedIds = passes.flatMap((pass) => pass.closedLots.map((lot) => lot.lotId));
    expect(closedIds.sort()).toEqual([...lots].sort());
    const { rows } = await pool.query<{ kind: string; count: number }>(
      `select payload->>'kind' as kind, count(*)::int as count from event_log
       where event_id = $1 and payload->>'kind' in ('lot_closed', 'lot_won', 'event_closed')
       group by 1 order by 1`,
      [eventId],
    );
    expect(rows).toEqual([
      { kind: "event_closed", count: 1 },
      { kind: "lot_closed", count: 6 },
      { kind: "lot_won", count: 6 },
    ]);
  });

  it("never closes a lot early when the caller's clock runs ahead of the database", async () => {
    const eventId = await createEvent(pool);
    const lotId = await createLot(pool, eventId, { number: 1, startingBidCents: 1_000, minRaiseCents: 100, closesInSeconds: 60 });
    const anHourAhead = new Date(Date.now() + 60 * 60 * 1000);
    expect((await closeDueLots(anHourAhead, { pool })).closedLots).toEqual([]);
    expect((await lotRow(pool, lotId)).status).toBe("open");
  });

  it("closes the whole event at once, moving closes_at back to the moment of closing", async () => {
    const eventId = await createEvent(pool);
    const guest = await paddleWithHold(eventId, 142, 50_000);
    const first = await createLot(pool, eventId, { number: 1, startingBidCents: 10_000, minRaiseCents: 1_000 });
    const second = await createLot(pool, eventId, { number: 2, startingBidCents: 5_000, minRaiseCents: 500 });
    await createLimits(guest, [{ lotId: first, maxCents: 20_000 }, { lotId: second, maxCents: 10_000 }], { pool });
    const scheduled = (await lotRow(pool, second)).closes_at;

    expect(await closeEvent(eventId, { pool })).toMatchObject({ eventClosed: true, closedLots: [{}, {}] });
    const lot = await lotRow(pool, second);
    expect(lot.status).toBe("closed");
    expect(lot.closes_at.getTime()).toBeLessThan(scheduled.getTime());
    const { rows } = await pool.query<{ after_close: boolean }>(
      `select bool_or(b.created_at >= l.closes_at or b.created_at >= l.closed_at) as after_close
       from bids b join lots l on l.id = b.lot_id where l.event_id = $1`,
      [eventId],
    );
    expect(rows[0]?.after_close).toBe(false);
    expect(await eventStatus(eventId)).toBe("closed");
    expect(await placeBid(guest, second, 6_000, "guest", { pool })).toMatchObject({
      ok: false,
      refusal: { reason: "lot_closed" },
    });
    expect(await closeEvent(eventId, { pool })).toEqual({ closedLots: [], eventClosed: false });
  });

  it("closes a live event whose lots all closed earlier without it", async () => {
    const eventId = await createEvent(pool);
    await createLot(pool, eventId, { number: 1, startingBidCents: 1_000, minRaiseCents: 100, status: "closed" });
    expect((await closeDueLots(undefined, { pool })).closedEventIds).toContain(eventId);
    expect(await eventStatus(eventId)).toBe("closed");
  });
});
