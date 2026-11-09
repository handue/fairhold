/**
 * The demo controls an organizer has in the role menu: close the next lot, close bidding, add 10
 * minutes, invite a guest, reset. Each is a server function; the route checks the session first.
 * Lots' status, winners and bids stay the engine's: these only move close times, as the scope map's
 * golden path says, under the engine's lock order (lots by id, then the event, then event_log).
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { startDemoGala, type StartedDemo } from "@/server/demo/start";
import { closeDueLots, closeEvent, eventHasEnded } from "@/server/engine";
import type { EventStatus } from "@/server/engine/types";
import { getPayments } from "@/server/paypal/runtime";
import type { Session } from "@/server/sessions";
import { appendEventLog } from "@/server/sse/notify";
import type { ScheduleChangedPayload } from "@/server/sse/types";
import { joinHref } from "@/ui/routes";

import { withDirectorTransaction } from "./db";
import { liveAuthorizationsOf, releaseAuthorization, type ReleaseDependencies } from "./holds";
import { cancelQueuedJobs } from "./jobs";
import { fenceSettlement, retireDemo } from "./retire";

export const ADD_TIME_MS = 10 * 60 * 1_000;
/** A demo must end before its 6-hour cleanup, with this long left for charging. */
const END_BEFORE_CLEANUP_MS = 30 * 60 * 1_000;
/** How long the Reset request waits for PayPal; the sweep finishes whatever is left. */
const RESET_VOID_WAIT_MS = 8_000;

export interface DemoEvent {
  id: string;
  slug: string;
  status: EventStatus;
  timeZone: string;
}

/** The event behind a control, which exists only on demo galas. */
export async function requireDemoEvent(slug: string, db: Queryable = getPool()): Promise<DemoEvent> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    status: EventStatus;
    timezone: string;
    is_demo: boolean;
  }>("select id, slug, status, timezone, is_demo from events where slug = $1", [slug]);
  const row = rows[0];
  if (!row) throw new ApiError(404, "event_not_found", "We could not find this event.");
  if (!row.is_demo) throw new ApiError(403, "demo_only", "This control only works on a demo gala.");
  return { id: row.id, slug: row.slug, status: row.status, timeZone: row.timezone };
}

const biddingClosed = () => new ApiError(409, "event_closed", "Bidding has closed for this event.");

function scheduleChanged(eventId: string, payload: Omit<ScheduleChangedPayload, "kind">) {
  return { eventId, paddleId: null, type: "event_status" as const, payload: { kind: "schedule_changed" as const, ...payload } };
}

export interface ClosedNextLot {
  lotNumber: number;
  shortTitle: string;
  /** The lots still open after this one. */
  openLots: number;
}

/**
 * The open lot closest to its end closes now: its close time moves to this instant, so the engine
 * refuses every later bid, and it is closed here too rather than on the tick's next round.
 */
export async function closeNextLot(event: DemoEvent, pool: pg.Pool = getPool()): Promise<ClosedNextLot> {
  if (eventHasEnded(event.status)) throw biddingClosed();
  const moved = await withDirectorTransaction(pool, async ({ client }) => {
    const { rows } = await client.query<{ id: string; number: number; short_title: string }>(
      `select id, number, short_title from lots
       where event_id = $1 and status = 'open' and closes_at > clock_timestamp()
       order by closes_at, number
       limit 1
       for update`,
      [event.id],
    );
    const lot = rows[0];
    if (!lot) return null;
    const { rows: updated } = await client.query<{ closes_at: Date }>(
      "update lots set closes_at = clock_timestamp() where id = $1 returning closes_at",
      [lot.id],
    );
    const closesAt = updated[0]?.closes_at ?? new Date();
    await appendEventLog(client, [
      scheduleChanged(event.id, { closesAt: null, lots: [{ lotId: lot.id, lotNumber: lot.number, closesAt: closesAt.getTime() }] }),
    ]);
    return lot;
  });
  if (!moved) throw biddingClosed();

  // The tick does this within a second, so a failure here costs nothing.
  await closeDueLots(undefined, { pool }).catch((error: unknown) => console.error("[director] closing the lot failed:", error));
  const { rows } = await pool.query<{ open: number }>(
    "select count(*)::int as open from lots where event_id = $1 and status = 'open'",
    [event.id],
  );
  return { lotNumber: moved.number, shortTitle: moved.short_title, openLots: rows[0]?.open ?? 0 };
}

export interface ClosedBidding {
  closedLots: number;
  eventClosed: boolean;
}

/** Every open lot closes at this moment, through the engine. Pressing it twice changes nothing. */
export async function closeBiddingNow(event: DemoEvent, pool: pg.Pool = getPool()): Promise<ClosedBidding> {
  const { closedLots, eventClosed } = await closeEvent(event.id, { pool });
  await cancelQueuedJobs(pool, event.id);
  return { closedLots: closedLots.length, eventClosed };
}

export interface AddedTime {
  closesAt: Date;
  lots: number;
}

/**
 * Ten more minutes on the event and on every lot still ahead of its close; a lot already past its
 * close stays closed. The background bids left on each lot spread out over its new time, so the
 * extra minutes are not a silent stretch at the end.
 */
export async function addTime(event: DemoEvent, pool: pg.Pool = getPool()): Promise<AddedTime> {
  const moved = await withDirectorTransaction(pool, async ({ client }) => {
    const { rows: lots } = await client.query<{ id: string; number: number; closes_at: Date }>(
      "select id, number, closes_at from lots where event_id = $1 and status = 'open' order by id for update",
      [event.id],
    );
    const { rows: events } = await client.query<{ status: EventStatus; closes_at: Date; demo_expires_at: Date | null; clock: Date }>(
      "select status, closes_at, demo_expires_at, clock_timestamp() as clock from events where id = $1 for no key update",
      [event.id],
    );
    const row = events[0];
    if (!row || row.status !== "live") throw biddingClosed();

    const closesAt = new Date(row.closes_at.getTime() + ADD_TIME_MS);
    if (row.demo_expires_at && closesAt.getTime() > row.demo_expires_at.getTime() - END_BEFORE_CLEANUP_MS) {
      throw new ApiError(409, "demo_time_limit", "This demo can’t run any longer.");
    }
    // Compared with the database clock, as bids are: a lot past its close never reopens.
    const ahead = lots.filter((lot) => lot.closes_at.getTime() > row.clock.getTime());
    const moves = ahead.map((lot) => ({
      ...lot,
      movedTo: new Date(lot.closes_at.getTime() + ADD_TIME_MS),
      leftMs: lot.closes_at.getTime() - row.clock.getTime(),
    }));
    await client.query("update lots set closes_at = closes_at + make_interval(secs => $2::float8) where id = any($1)", [
      moves.map((lot) => lot.id),
      ADD_TIME_MS / 1_000,
    ]);
    await client.query("update events set closes_at = $2 where id = $1", [event.id, closesAt]);
    await appendEventLog(client, [
      scheduleChanged(event.id, {
        closesAt: closesAt.getTime(),
        lots: moves.map((lot) => ({ lotId: lot.id, lotNumber: lot.number, closesAt: lot.movedTo.getTime() })),
      }),
    ]);
    return { closesAt, moves };
  });

  await stretchBackgroundBids(pool, event.id, moved.moves);
  return { closesAt: moved.closesAt, lots: moved.moves.length };
}

/**
 * After the lots' locks are gone, because a job locks its own row before its lot. Each queued bid
 * keeps its place in what is left of its lot's time, so it stays before the lot's new close.
 */
async function stretchBackgroundBids(pool: pg.Pool, eventId: string, moves: readonly { id: string; leftMs: number }[]): Promise<void> {
  await pool.query(
    `update director_jobs j
     set run_at = clock_timestamp() + (j.run_at - clock_timestamp()) * s.ratio
     from unnest($2::uuid[], $3::float8[]) as s(lot_id, ratio)
     where j.event_id = $1 and j.status = 'queued' and j.kind = 'bot_bid' and (j.payload->>'lotId')::uuid = s.lot_id
       and j.run_at > clock_timestamp()`,
    [eventId, moves.map((lot) => lot.id), moves.map((lot) => (lot.leftMs + ADD_TIME_MS) / lot.leftMs)],
  );
}

/**
 * The event's join page. The slug is unguessable, and anyone with this link gets the next real
 * paddle without organizer rights, so a judge can see both a capture and a void.
 */
export function inviteHref(event: DemoEvent): string {
  if (eventHasEnded(event.status)) throw biddingClosed();
  return joinHref(event.slug);
}

export interface ResetInput {
  event: DemoEvent;
  session: Session;
  dependencies?: Partial<ReleaseDependencies>;
  voidWaitMs?: number;
}

/** Waits for the voids, but not for long: whatever is still going on is the sweep's to finish. */
async function releaseWithin(limitMs: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, limitMs);
  });
  await Promise.race([work.catch((error: unknown) => console.error("[director] releasing holds on reset failed:", error)), timeout]);
  clearTimeout(timer);
}

/**
 * Ends the gala a Reset replaces, in the new gala's transaction, so the two commit together: its
 * organizer's session goes, and it expires, which marks it as already reset and hands it to the
 * sweep. A closed gala stops being chargeable here too; a live one still has bidding to close.
 */
async function endForReset(client: pg.PoolClient, eventId: string): Promise<void> {
  // Read after the row lock with the wall clock, not now(): a press that waited for this one to
  // commit began before it, and must still see the expiry it wrote.
  const { rows } = await client.query<{ reset: boolean }>(
    "select coalesce(demo_expires_at <= clock_timestamp(), false) as reset from events where id = $1 for no key update",
    [eventId],
  );
  if (!rows[0]) throw new ApiError(404, "event_not_found", "We could not find this event.");
  if (rows[0].reset) throw new ApiError(409, "demo_already_reset", "This demo has already ended.");
  if ((await fenceSettlement(client, eventId)) === "settlement_running") {
    throw new ApiError(409, "settlement_running", "Charging is still running. Reset when it has finished.");
  }
  await client.query("update events set demo_expires_at = least(demo_expires_at, now()) where id = $1", [eventId]);
  await client.query("delete from sessions where event_id = $1 and is_organizer", [eventId]);
}

/**
 * Reset demo: this gala ends and its real holds are voided, and its organizer lands in a new gala
 * with paddle 142. A refused Reset changes nothing: the new gala and the end of this one are one
 * transaction, which answers 503 when no new gala can start, 409 settlement_running while a void could
 * race a capture, and 409 demo_already_reset on a second press. The rest can happen after the answer:
 * the sweep retries any void still owed and deletes the old gala, and a guest it invited sees it
 * closed until then.
 */
export async function resetDemo({ event, session, dependencies = {}, voidWaitMs = RESET_VOID_WAIT_MS }: ResetInput): Promise<StartedDemo> {
  const pool = dependencies.pool ?? getPool();
  const release: ReleaseDependencies = { pool, paymentsFor: dependencies.paymentsFor ?? getPayments };
  const started = await startDemoGala(
    {
      firstName: session.firstName ?? session.organizerName ?? "Guest",
      timeZone: event.timeZone,
      clientKey: null,
      replaces: { eventId: event.id, end: (client) => endForReset(client, event.id) },
    },
    pool,
  );

  // The organizer's way into the old gala is gone, so a failure here must not cost them the new one.
  try {
    if ((await retireDemo(pool, event.id)) === "retired") {
      const holds = await liveAuthorizationsOf(pool, event.id);
      await releaseWithin(voidWaitMs, Promise.all(holds.map((hold) => releaseAuthorization(hold, release))));
    }
  } catch (error) {
    console.error("[director] retiring the old gala on reset failed; the sweep finishes it:", error);
  }
  return started;
}
