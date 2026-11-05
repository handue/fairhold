import { describe, expect, it } from "vitest";

import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { getBiddingPower } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

/** Paddles whose commitments exceed their hold, by the engine's own calculation (COMMITMENTS_SQL). */
async function overcommittedPaddles(eventId: string): Promise<number[]> {
  const { rows } = await pool.query<{ id: string; number: number }>(
    "select id, number from paddles where event_id = $1",
    [eventId],
  );
  const power = await getBiddingPower(rows.map((row) => row.id), pool);
  return rows
    .filter((row) => {
      const paddle = power.get(row.id);
      return !paddle || paddle.committedCents > paddle.holdCents;
    })
    .map((row) => row.number);
}

const BIDS_IN_EVENT = "select count(*)::int as n from bids b join lots l on l.id = b.lot_id where l.event_id = $1";

async function count(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
}

describe("createDemoEvent", () => {
  it("clones the template into a private 25-minute gala with 85 simulated guests", async () => {
    const { event, creator } = await createDemoEvent({ creatorFirstName: " Alex ", timeZone: "America/Chicago" }, pool);

    expect(event.slug).toMatch(/^gala-[0-9a-hjkmnp-tv-z]{16}$/);
    expect(event).toMatchObject({ isDemo: true, status: "live", timeZone: "America/Chicago" });
    expect(creator).toMatchObject({ paddleNumber: 142, firstName: "Alex", isOrganizer: true });
    expect(event.closesAt.getTime() - (event.demoExpiresAt?.getTime() ?? 0)).toBe(-(6 * 60 - 25) * 60_000);

    const id = [event.id];
    expect(await count("select count(*)::int as n from lots where event_id = $1", id)).toBe(24);
    expect(await count("select count(*)::int as n from paddles where event_id = $1", id)).toBe(86);
    expect(await count("select count(*)::int as n from paddles where event_id = $1 and is_simulated", id)).toBe(85);
    const simulatedHolds = `select count(*)::int as n from holds
      where event_id = $1 and status = 'authorized' and kind = 'simulated'`;
    expect(await count(simulatedHolds, id)).toBe(85);
    expect(await count("select count(*)::int as n from holds where paddle_id = $1", [creator.paddleId])).toBe(0);
    expect(await count(BIDS_IN_EVENT, id)).toBe(231);

    const schedule = await pool.query<{ minutes: number; lots: number }>(
      `select round(extract(epoch from (l.closes_at - e.closes_at)) / 60)::int as minutes, count(*)::int as lots
       from lots l join events e on e.id = l.event_id
       where e.id = $1 group by 1 order by 1`,
      id,
    );
    const staggered = schedule.rows.filter((row) => row.minutes < 0);
    expect(staggered.reduce((sum, row) => sum + row.lots, 0)).toBe(8);
    expect(staggered.every((row) => row.minutes >= -15 && row.minutes <= -5)).toBe(true);
    expect(schedule.rows.find((row) => row.minutes === 0)?.lots).toBe(16);

    expect(await overcommittedPaddles(event.id)).toEqual([]);
  });

  it("gives every demo its own slug and paddles", async () => {
    const first = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    const second = await createDemoEvent({ creatorFirstName: "Kai" }, pool);
    expect(first.event.slug).not.toBe(second.event.slug);
    expect(first.creator.paddleId).not.toBe(second.creator.paddleId);
    expect(first.event.timeZone).toBe("America/Los_Angeles");
  });
});

describe("createFixtureEvent", () => {
  it("recreates riverside-shelter-gala at 8:58 PM with 08's and 05's figures", async () => {
    const first = await createFixtureEvent({}, pool);
    const fixture = await createFixtureEvent({}, pool);
    expect(fixture.event.slug).toBe("riverside-shelter-gala");
    expect(await count("select count(*)::int as n from events where slug = $1", [fixture.event.slug])).toBe(1);
    expect(await count("select count(*)::int as n from paddles where event_id = $1", [first.event.id])).toBe(0);

    const id = [fixture.event.id];
    expect(await count("select sum(current_bid_cents)::int as n from lots where event_id = $1", id)).toBe(684_000);
    const lot7 = await pool.query<{ current: number; bids: number; high: number; cover: string }>(
      `select l.current_bid_cents as current, l.bid_count as bids, p.number as high, ph.illustration_key as cover
       from lots l join paddles p on p.id = l.high_paddle_id left join lot_photos ph on ph.id = l.cover_photo_id
       where l.event_id = $1 and l.number = 7`,
      id,
    );
    expect(lot7.rows[0]).toEqual({ current: 32_000, bids: 12, high: 142, cover: "cloche" });
    const jamiesHold = "select count(*)::int as n from holds where paddle_id = $1 and amount_cents = 50000";
    expect(await count(jamiesHold, [fixture.jamie.paddleId])).toBe(1);
    expect(await overcommittedPaddles(fixture.event.id)).toEqual([]);
  });

  it("reproduces 12 at 9:30 PM: 19 winners charged $8,160 of $43,950 held", async () => {
    const fixture = await createFixtureEvent({ moment: "closed" }, pool);
    const id = [fixture.event.id];
    const ledger = await pool.query<{ winners: number; charge: number; held: number }>(
      `select
         (select count(distinct winning_paddle_id)::int from lots where event_id = $1) as winners,
         (select coalesce(sum(winning_cents), 0)::int from lots where event_id = $1) as charge,
         (select sum(amount_cents)::int from holds where event_id = $1 and status = 'authorized') as held`,
      id,
    );
    expect(ledger.rows[0]).toEqual({ winners: 19, charge: 816_000, held: 4_395_000 });
    expect(
      await count(
        `select count(*)::int as n from bids b join lots l on l.id = b.lot_id
         where l.event_id = $1 and b.source = 'glim' and b.glim_action_id is not null and b.limit_id is not null`,
        id,
      ),
    ).toBe(96);
    const activeLimits = `select count(*)::int as n from bid_limits bl join lots l on l.id = bl.lot_id
      where l.event_id = $1 and bl.active`;
    expect(await count(activeLimits, id)).toBe(0);
    expect(await overcommittedPaddles(fixture.event.id)).toEqual([]);
  });
});
