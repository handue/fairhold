/**
 * Reads screen 14's rows (projector-view.ts builds the view). The event and its lots come from the
 * guest read source, as 08's do, so a frozen clock works; who leads, who has bid and Glim's counts
 * come from Postgres. Public: nothing here names a guest.
 */
import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { isOrWasBiddingPowerSql } from "@/server/holds/bidding-hold";
import { getDevelopmentSwitches } from "@/server/lib/env";

import { NO_PROJECTOR_EXTRAS, type ProjectorExtras, type ProjectorSeed } from "./projector-view";
import { getGuestReadSource } from "./source";
import type { GuestReadSource } from "./types";

export { buildProjectorView, foldProjectorExtras, type ProjectorSeed, type ProjectorView } from "./projector-view";

/** The leaders, bidders and Glim's counts of one event. */
export async function readProjectorExtras(db: Queryable, eventId: string): Promise<ProjectorExtras & { isDemo: boolean; pickupNote: string | null }> {
  const [leaders, bidders, glim, event] = await Promise.all([
    // Amounts strictly rise on a lot, so the bid at the current (or winning) amount is the leader's.
    db.query<{ lot_id: string; number: number; source: string }>(
      `select l.id::text as lot_id, p.number::integer as number, b.source::text as source
       from lots l
       join bids b on b.lot_id = l.id and b.amount_cents = coalesce(l.winning_cents, l.current_bid_cents)
       join paddles p on p.id = b.paddle_id
       where l.event_id = $1`,
      [eventId],
    ),
    // Held: bidding power at some point, never only an approval refused as it (src/server/holds/bidding-hold.ts).
    db.query<{ id: string }>(
      `select p.id::text as id from paddles p
       where p.event_id = $1
         and (exists (select 1 from holds h where h.paddle_id = p.id and ${isOrWasBiddingPowerSql("h")})
           or exists (select 1 from bids b where b.paddle_id = p.id))`,
      [eventId],
    ),
    db.query<{ paddle_id: string; bids: number; over_limit: number }>(
      `select b.paddle_id::text as paddle_id, count(*)::int as bids,
         count(*) filter (where bl.id is null or b.amount_cents > bl.max_cents)::int as over_limit
       from bids b
       join lots l on l.id = b.lot_id
       left join bid_limits bl on bl.id = b.limit_id
       where l.event_id = $1 and b.source = 'glim'
       group by b.paddle_id`,
      [eventId],
    ),
    db.query<{ is_demo: boolean; pickup_note: string | null }>("select is_demo, pickup_note from events where id = $1", [eventId]),
  ]);
  return {
    leaders: Object.fromEntries(leaders.rows.map((row) => [row.lot_id, { paddleNumber: row.number, byGlim: row.source === "glim" }])),
    bidderIds: bidders.rows.map((row) => row.id),
    glimPaddleIds: glim.rows.map((row) => row.paddle_id),
    glimBids: glim.rows.reduce((sum, row) => sum + row.bids, 0),
    glimWithinLimits: glim.rows.every((row) => row.over_limit === 0),
    isDemo: event.rows[0]?.is_demo ?? false,
    pickupNote: event.rows[0]?.pickup_note ?? null,
  };
}

/** 14's rows and the stream position they include every row up to. Null when the event is unknown. */
export async function getProjectorSeed(slug: string, source?: GuestReadSource): Promise<ProjectorSeed | null> {
  const reads = source ?? (await getGuestReadSource());
  const streamPosition = (await reads.streamPosition?.(slug)) ?? "0";
  const event = await reads.findEvent(slug);
  if (!event) return null;
  const [now, lots] = await Promise.all([reads.currentTime(), reads.listLots(event.id)]);
  const extras =
    getDevelopmentSwitches().uiFixture !== null
      ? { ...NO_PROJECTOR_EXTRAS, isDemo: false, pickupNote: null }
      : await readProjectorExtras(getPool(), event.id);
  return { streamPosition, now, event, lots, paddle: null, viewerLots: [], ...extras };
}
