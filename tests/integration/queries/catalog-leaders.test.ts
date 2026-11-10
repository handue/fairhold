/**
 * 08's "Sold to Paddle 117" (design/20 state 4): the catalog's seed names the paddles leading or
 * holding each lot, read in one query, and a closed lot's winner is among them.
 */
import { describe, expect, it } from "vitest";

import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { getCatalogSeed } from "@/server/queries/catalog";
import { getGuestReadSource } from "@/server/queries/source";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

describe("the catalog seed's paddle numbers", () => {
  it("names every leader, and the winner of a lot that closed", async () => {
    await createFixtureEvent({ moment: "catalog" }, pool);
    // Lot 21 closes on Priya's $95, as at 9:13 PM.
    await pool.query(
      `update lots set status = 'closed', winning_paddle_id = high_paddle_id, winning_cents = current_bid_cents, closed_at = closes_at
       where event_id = (select id from events where slug = $1) and number = 21`,
      [FIXTURE_SLUG],
    );

    const seed = await getCatalogSeed({ slug: FIXTURE_SLUG, paddleNumber: 142, category: null }, await getGuestReadSource());
    if (!seed) throw new Error("the fixture event is missing");

    const lot21 = seed.lots.find((lot) => lot.number === 21);
    expect(lot21?.winningPaddleId).toBeTruthy();
    expect(seed.paddleNumbers[lot21?.winningPaddleId ?? ""]).toBe(117);

    const jamie = seed.paddle?.id ?? "";
    expect(seed.paddleNumbers[jamie]).toBe(142);
    for (const lot of seed.lots) {
      if (lot.highPaddleId) expect(seed.paddleNumbers[lot.highPaddleId]).toEqual(expect.any(Number));
    }
    // Only paddles that lead or won something: no list of every guest.
    const leaders = new Set(seed.lots.flatMap((lot) => [lot.highPaddleId, lot.winningPaddleId]).filter(Boolean));
    expect(Object.keys(seed.paddleNumbers).sort()).toEqual([...leaders].sort());
  });
});
