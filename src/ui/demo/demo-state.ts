/**
 * What the event layout's demo slot needs to know, read on the server: whether the event is a demo
 * gala, whether that gala has ended (reset, past its 6-hour life, or already deleted), and how far
 * its creator has come through the demo guide. Server only: it reads Postgres.
 */
import type pg from "pg";

import { getPool } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import { isOrWasBiddingPowerSql } from "@/server/holds/bidding-hold";
import { getDevelopmentSwitches } from "@/server/lib/env";
import type { EventStatus } from "@/server/queries/types";

export type DemoGalaState =
  /** No event has this slug: a demo the sweep deleted, or a link that never worked. */
  | { kind: "missing" }
  /** A demo gala past demo_expires_at: reset, or at the end of its 6 hours. The sweep deletes it soon. */
  | { kind: "ended" }
  | { kind: "event"; eventId: string; isDemo: boolean; status: EventStatus; timeZone: string };

/** Under UI_FIXTURE there is no database: the fixture is the seeded event, which is no demo. */
const FIXTURE_EVENT: DemoGalaState = {
  kind: "event",
  eventId: "fixture",
  isDemo: false,
  status: "live",
  timeZone: "America/Los_Angeles",
};

export async function readDemoGala(slug: string, pool: pg.Pool = getPool()): Promise<DemoGalaState> {
  if (getDevelopmentSwitches().uiFixture !== null) return FIXTURE_EVENT;
  if (holdsNul(slug)) return { kind: "missing" };
  const { rows } = await pool.query<{
    id: string;
    is_demo: boolean;
    ended: boolean;
    status: EventStatus;
    timezone: string;
  }>(
    `select id::text as id, is_demo, status::text as status, timezone,
       coalesce(is_demo and demo_expires_at <= now(), false) as ended
     from events where slug = $1`,
    [slug],
  );
  const row = rows[0];
  if (!row) return { kind: "missing" };
  if (row.ended) return { kind: "ended" };
  return { kind: "event", eventId: row.id, isDemo: row.is_demo, status: row.status, timeZone: row.timezone };
}

/**
 * The demo guide's steps, in order. V5 (design/21) adds "Heart a lot you'd also like" before
 * bidding, so the plan card has a backup to list.
 */
export const GUIDE_STEPS = ["power", "heart", "bid", "close", "charge"] as const;
export type GuideStep = (typeof GUIDE_STEPS)[number];
export type GuideProgress = Record<GuideStep, boolean>;

const ENDED: ReadonlySet<EventStatus> = new Set(["closed", "settling", "settled"]);

/** Which steps a paddle has done: each from a fact the database already keeps. */
export async function readGuideProgress(
  input: { paddleId: string; status: EventStatus },
  pool: pg.Pool = getPool(),
): Promise<GuideProgress> {
  const { rows } = await pool.query<{ power: boolean; heart: boolean; bid: boolean }>(
    `select
       exists (select 1 from holds h where h.paddle_id = $1 and ${isOrWasBiddingPowerSql("h")}) as power,
       exists (select 1 from favorites where paddle_id = $1) as heart,
       exists (select 1 from bids where paddle_id = $1)
         or exists (select 1 from glim_plans where paddle_id = $1 and confirmed_at is not null) as bid`,
    [input.paddleId],
  );
  const facts = rows[0] ?? { power: false, heart: false, bid: false };
  return {
    power: facts.power,
    heart: facts.heart,
    bid: facts.bid,
    close: ENDED.has(input.status),
    charge: input.status === "settled",
  };
}
