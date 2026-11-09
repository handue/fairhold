/**
 * The seeded fixture stays live whatever day it is seeded, with the approved figures and the
 * approved clock times. The bid goes through the engine on the real database clock, so this test
 * would fail on every day after the fixture's date if the fixture stopped moving.
 */
import { describe, expect, it } from "vitest";

import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { defaultFixtureDate, pm, storyShiftMs } from "@/server/demo/storyClock";
import { getBiddingPower, placeBid } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

const lotId = async (eventId: string, number: number) => {
  const { rows } = await pool.query<{ id: string }>("select id from lots where event_id = $1 and number = $2", [eventId, number]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`No lot ${number}`);
  return id;
};

const pacificClock = "to_char(%s at time zone 'America/Los_Angeles', 'FMHH12:MI:SS AM')";

describe("createFixtureEvent's default evening", () => {
  it("is the first evening whose close is more than an hour away, by the database clock", async () => {
    const fixture = await createFixtureEvent({}, pool);
    const { rows } = await pool.query<{ now: Date }>("select now() as now");
    const now = rows[0]?.now ?? new Date();
    expect(fixture.on).toBe(defaultFixtureDate(now));
    expect(fixture.event.status).toBe("live");
    expect(fixture.event.closesAt.getTime() - now.getTime()).toBeGreaterThan(60 * 60_000);
    expect(fixture.event.closesAt.getTime() - now.getTime()).toBeLessThan(48 * 60 * 60_000);
  });

  it("takes a bid through the engine right now", async () => {
    const fixture = await createFixtureEvent({}, pool);
    const spaDay = await lotId(fixture.event.id, 12);

    const bid = await placeBid(fixture.jamie.paddleId, spaDay, 9_000, "guest", { pool });

    expect(bid).toMatchObject({ ok: true, leading: true });
    expect((await getBiddingPower([fixture.jamie.paddleId], pool)).get(fixture.jamie.paddleId)).toMatchObject({
      holdCents: 50_000,
      committedCents: 41_000,
    });
  });

  it("keeps the approved figures and clock times", async () => {
    const fixture = await createFixtureEvent({}, pool);
    const { rows } = await pool.query<{ raised: number; event_close: string; event_open: string; lot_7: string; at_930: number }>(
      `select
         (select sum(current_bid_cents)::int from lots where event_id = e.id) as raised,
         ${pacificClock.replace("%s", "e.closes_at")} as event_close,
         ${pacificClock.replace("%s", "e.opens_at")} as event_open,
         (select ${pacificClock.replace("%s", "closes_at")} from lots where event_id = e.id and number = 7) as lot_7,
         (select count(*)::int from lots where event_id = e.id and closes_at = e.closes_at) as at_930
       from events e where e.id = $1`,
      [fixture.event.id],
    );
    expect(rows[0]).toEqual({ raised: 684_000, event_close: "9:30:00 PM", event_open: "7:00:00 PM", lot_7: "9:16:42 PM", at_930: 16 });
  });

  it("says when to freeze the clock: 8:58 PM on that evening", async () => {
    const fixture = await createFixtureEvent({}, pool);
    const { rows } = await pool.query<{ shown: string }>(
      `select to_char($1::timestamptz at time zone 'America/Los_Angeles', 'YYYY-MM-DD FMHH12:MI:SS AM') as shown`,
      [fixture.at],
    );
    expect(rows[0]?.shown).toBe(`${fixture.on} 8:58:00 PM`);
    expect(fixture.at.getTime() - pm("8:58").getTime()).toBe(storyShiftMs(fixture.on));
  });
});

describe("createFixtureEvent on a chosen evening", () => {
  it("moves everything to that evening", async () => {
    const fixture = await createFixtureEvent({ on: "2031-06-10" }, pool);
    expect(fixture.on).toBe("2031-06-10");
    const { rows } = await pool.query<{ closes: string; first_hold: string; first_bid: string }>(
      `select
         to_char(e.closes_at at time zone 'America/Los_Angeles', 'YYYY-MM-DD FMHH12:MI AM') as closes,
         (select to_char(min(authorized_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD') from holds where event_id = e.id) as first_hold,
         (select to_char(min(b.created_at) at time zone 'America/Los_Angeles', 'YYYY-MM-DD')
          from bids b join lots l on l.id = b.lot_id where l.event_id = e.id) as first_bid
       from events e where e.id = $1`,
      [fixture.event.id],
    );
    expect(rows[0]).toEqual({ closes: "2031-06-10 9:30 PM", first_hold: "2031-06-10", first_bid: "2031-06-10" });
  });

  it("reproduces the evening the screens were drawn in, whose lots the engine now refuses", async () => {
    const fixture = await createFixtureEvent({ on: "2026-11-07" }, pool);
    expect(fixture.at).toEqual(pm("8:58"));
    expect(fixture.event.closesAt).toEqual(pm("9:30"));
    const spaDay = await lotId(fixture.event.id, 12);
    const bid = await placeBid(fixture.jamie.paddleId, spaDay, 9_000, "guest", { pool });
    expect(bid).toMatchObject({ ok: false, refusal: { reason: "lot_closed" } });
  });

  it("refuses a date that does not exist, and leaves the old fixture", async () => {
    const before = await createFixtureEvent({}, pool);
    await expect(createFixtureEvent({ on: "2026-02-30" }, pool)).rejects.toThrow(RangeError);
    const { rows } = await pool.query<{ id: string }>("select id from events where slug = $1", [before.event.slug]);
    expect(rows[0]?.id).toBe(before.event.id);
  });

  it.each(["paddle", "closed"] as const)("moves the %s moment too", async (moment) => {
    const fixture = await createFixtureEvent({ moment, on: "2031-06-10" }, pool);
    expect(fixture.event.closesAt.toISOString()).toBe("2031-06-11T04:30:00.000Z"); // PDT
    expect(fixture.event.status).toBe(moment === "closed" ? "closed" : "live");
  });
});
