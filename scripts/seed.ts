/**
 * Seeds the approved fixture event, riverside-shelter-gala, into DATABASE_URL (fairhold_dev
 * locally). Running it again deletes and recreates the event.
 *
 *   npm run db:seed                        08 Lots and 05 Lot 07, at 8:58 PM
 *   npm run db:seed -- --moment=paddle     10 My paddle and 14 Projector, at 9:15:40 PM
 *   npm run db:seed -- --moment=closed     12 Control room, bidding closed at 9:30 PM
 *   npm run db:seed -- --date=2026-11-07   on that evening; screens that print the date read as drawn
 *
 * By default the gala runs on the first evening whose 9:30 PM close (Pacific) is more than an hour
 * away, at the story's wall-clock times, so it stays live and the engine takes its bids. Its
 * countdowns read as approved only with the app clock frozen at the printed FREEZE_CLOCK_AT.
 */
import { createDatabaseClient } from "@/server/db/client";
import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_MOMENTS, isCalendarDate, type FixtureMoment } from "@/server/demo/storyClock";
import { getDatabaseUrl } from "@/server/lib/env";

import { loadLocalEnv } from "./lib/load-local-env";

function parseMoment(args: readonly string[]): FixtureMoment {
  const flag = args.find((arg) => arg.startsWith("--moment="));
  const value = flag?.slice("--moment=".length) ?? "catalog";
  if (!Object.hasOwn(FIXTURE_MOMENTS, value)) {
    throw new Error(`--moment must be one of ${Object.keys(FIXTURE_MOMENTS).join(", ")}; got "${value}"`);
  }
  return value as FixtureMoment;
}

function parseDate(args: readonly string[]): string | undefined {
  const value = args.find((arg) => arg.startsWith("--date="))?.slice("--date=".length);
  if (value !== undefined && !isCalendarDate(value)) {
    throw new Error(`--date must be a calendar date like 2026-11-08; got "${value}"`);
  }
  return value;
}

async function main(): Promise<void> {
  loadLocalEnv();
  const moment = parseMoment(process.argv.slice(2));
  const on = parseDate(process.argv.slice(2));
  const { pool } = createDatabaseClient(getDatabaseUrl(), { maxConnections: 2 });
  try {
    const { rows } = await pool.query<{ events: string | null }>("select to_regclass('public.events')::text as events");
    if (!rows[0]?.events) {
      throw new Error('The database has no events table yet. Run "npm run db:migrate" first.');
    }

    const fixture = await createFixtureEvent({ moment, on }, pool);
    const summary = await pool.query<{ lots: number; paddles: number; bids: number; raised: number }>(
      `select
         (select count(*)::int from lots where event_id = $1) as lots,
         (select count(*)::int from paddles where event_id = $1) as paddles,
         (select count(*)::int from bids b join lots l on l.id = b.lot_id where l.event_id = $1) as bids,
         (select coalesce(sum(current_bid_cents), 0)::int from lots where event_id = $1) as raised`,
      [fixture.event.id],
    );
    const counts = summary.rows[0];
    const shownAt = fixture.at.toLocaleString("en-US", {
      timeZone: fixture.event.timeZone,
      dateStyle: "full",
      timeStyle: "medium",
    });
    console.log(`Seeded ${fixture.event.slug} at the "${moment}" moment (${shownAt}).`);
    if (counts) {
      const raised = (counts.raised / 100).toLocaleString("en-US");
      console.log(`${counts.lots} lots, ${counts.paddles} paddles, ${counts.bids} bids, $${raised} raised.`);
    }
    console.log(`To see it as approved: FREEZE_CLOCK_AT=${fixture.at.toISOString()} npm run dev`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
