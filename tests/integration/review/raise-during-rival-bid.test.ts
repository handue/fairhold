/**
 * Adversarial review (Day 1): lockAuthorizedHolds reads a second time only for the actor. A
 * limit holder whose hold is swapped by a raise while a rival's bid waits on that hold row drops
 * out of the snapshot (the old row is now 'replaced', the new one is not visible to the
 * statement), so its limit is "blocked" for no_hold and the rival keeps a lot the limit should
 * have answered. If the lot closes before anyone bids again, the wrong paddle wins.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { createLimits, placeBid } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold, createLot, createPaddle, lotRow } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

/** Waits until some backend of this database is blocked on a lock. */
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

describe("review: a raise that lands during a rival's bid", () => {
  it("still lets the raised paddle's limit answer the rival", async () => {
    const eventId = await createEvent(pool);
    const jamie = await createPaddle(pool, eventId, 142);
    await createHold(pool, eventId, jamie, 50_000);
    const director = await createPaddle(pool, eventId, 31);
    await createHold(pool, eventId, director, 200_000);
    const chefsTable = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000 });

    expect(await placeBid(director, chefsTable, 32_000, "bot", { pool })).toMatchObject({ ok: true });
    expect(await createLimits(jamie, [{ lotId: chefsTable, maxCents: 38_000 }], { pool })).toMatchObject({
      ok: true,
      bids: [{ paddleId: jamie, amountCents: 34_000 }],
    });

    // Jamie's raise to $750 commits its hold swap (what markAuthorized does) while the director's
    // $360 bid is waiting on Jamie's old hold row.
    const raise = await pool.connect();
    try {
      await raise.query("begin");
      await raise.query("update holds set status = 'replaced' where paddle_id = $1 and status = 'authorized'", [jamie]);
      await createHold(raise, eventId, jamie, 75_000);

      const rivalBid = placeBid(director, chefsTable, 36_000, "bot", { pool });
      await untilSomeoneWaitsOnALock();
      await raise.query("commit");

      const result = await rivalBid;
      // Failed before the Day 1 fix: Jamie's limit is skipped for no_hold and the director leads at $360.
      expect(result).toMatchObject({ ok: true, leading: false, proxyBids: [{ paddleId: jamie, amountCents: 38_000 }] });
    } finally {
      raise.release();
    }
    expect(await lotRow(pool, chefsTable)).toMatchObject({ high_paddle_id: jamie, current_bid_cents: 38_000 });
  });
});
