/**
 * Adversarial review (Day 1): lockLots decides past_close with now(), the transaction's start,
 * not the moment the lot lock is granted. A bid whose transaction began before closes_at but
 * queued behind another transaction's lock on the lot (last-second snipers queue exactly like
 * this; lock_timeout allows up to 5 s) is decided after closes_at by the database clock and is
 * still accepted. Its created_at is the transaction start, so the bid history and the engine's
 * own "bid at or after closes_at" check both show it as on time.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { placeBid } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

async function untilSomeoneWaitsOnALock(): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    const { rows } = await pool.query<{ waiting: number }>(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await sleep(10);
  }
  throw new Error("no backend started waiting on a lock");
}

describe("review: a bid decided after closes_at", () => {
  it("is refused when the lot lock is granted after closes_at", async () => {
    const eventId = await createEvent(pool);
    const guest = await createPaddle(pool, eventId, 142);
    await createHold(pool, eventId, guest, 50_000);
    const lotId = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });
    await pool.query("update lots set closes_at = clock_timestamp() + interval '1500 milliseconds' where id = $1", [
      lotId,
    ]);
    const pastClose = async () => {
      const { rows } = await pool.query<{ past: boolean }>(
        "select clock_timestamp() > closes_at as past from lots where id = $1",
        [lotId],
      );
      return rows[0]?.past ?? false;
    };

    // Another engine transaction holds the lot (a proxy war, a close, an earlier sniper).
    const ahead = await pool.connect();
    try {
      await ahead.query("begin");
      await ahead.query("select id from lots where id = $1 for update", [lotId]);

      const snipe = placeBid(guest, lotId, 10_000, "guest", { pool });
      await untilSomeoneWaitsOnALock();
      // The bid is already waiting on the lot, so its transaction began before closes_at.
      expect(await pastClose()).toBe(false);
      // Let the database clock pass closes_at while the bid waits, then release the lot.
      while (!(await pastClose())) await sleep(50);
      await ahead.query("commit");

      // Failed before the Day 1 fix: accepted, because past_close compared closes_at with the transaction's start.
      expect(await snipe).toMatchObject({ ok: false, refusal: { reason: "lot_closed" } });
    } finally {
      ahead.release();
    }
  });
});
