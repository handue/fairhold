/**
 * Reads event_log for the stream. Two rules keep a reader from ever skipping a row:
 *
 * - Ids commit in order within an event (the advisory lock in notify.ts), so once a position is
 *   read, every row at or before it is already visible.
 * - Replays read up to a position fixed first (`through`), so "everything up to here was read"
 *   stays true however many invisible rows lie between this viewer's rows.
 */
import type { Queryable } from "@/server/db/transaction";

import { ORGANIZER_STREAM_TYPES, STREAM_RECENT_ROWS, type StreamEvent, type StreamViewer } from "./types";

// The id is read as text, so "order by id" would sort on the text; these queries name the column.
const ROW_COLUMNS = `id::text as id, type, paddle_id as "paddleId",
  (extract(epoch from created_at) * 1000)::float8 as at, payload`;

/** The event's newest row, or "0" with none. */
export async function latestPosition(db: Queryable, eventId: string): Promise<string> {
  const { rows } = await db.query<{ position: string }>(
    "select coalesce(max(id), 0)::text as position from event_log where event_id = $1",
    [eventId],
  );
  return rows[0]?.position ?? "0";
}

/** Where a connection with no position starts: STREAM_RECENT_ROWS behind the newest row. */
export async function recentPosition(db: Queryable, eventId: string, count = STREAM_RECENT_ROWS): Promise<string> {
  const { rows } = await db.query<{ position: string }>(
    `select coalesce(
       (select id from event_log where event_id = $1 order by id desc offset $2 limit 1), 0
     )::text as position`,
    [eventId, count],
  );
  return rows[0]?.position ?? "0";
}

export interface VisibleRowsQuery {
  eventId: string;
  viewer: StreamViewer;
  /** Rows after this position... */
  after: string;
  /** ...up to and including this one. */
  through: string;
  limit: number;
}

/**
 * The rows of (after, through] one viewer may see, oldest first. The filter is canSeeStreamRow in
 * SQL; the two must agree, and tests/integration/sse/visibility.test.ts holds them together.
 */
export async function readVisibleRows(db: Queryable, query: VisibleRowsQuery): Promise<StreamEvent[]> {
  const { rows } = await db.query<StreamEvent>(
    `select ${ROW_COLUMNS}
     from event_log
     where event_id = $1 and id > $2::bigint and id <= $3::bigint
       and (paddle_id is null or paddle_id = $4::uuid or ($5::boolean and type::text = any($6::text[])))
     order by event_log.id
     limit $7`,
    [
      query.eventId,
      query.after,
      query.through,
      query.viewer.paddleId,
      query.viewer.isOrganizer,
      ORGANIZER_STREAM_TYPES,
      query.limit,
    ],
  );
  return rows;
}

/** Every channel's rows after a position, for fan-out; each subscriber then keeps what it may see. */
export async function readRowsAfter(db: Queryable, eventId: string, after: string, limit: number): Promise<StreamEvent[]> {
  const { rows } = await db.query<StreamEvent>(
    `select ${ROW_COLUMNS} from event_log where event_id = $1 and id > $2::bigint order by event_log.id limit $3`,
    [eventId, after, limit],
  );
  return rows;
}

/** Which of these events still exist; a deleted demo's streams end. */
export async function existingEventIds(db: Queryable, eventIds: readonly string[]): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>("select id from events where id = any($1::uuid[])", [eventIds]);
  return new Set(rows.map((row) => row.id));
}

/** The database clock, which bids are judged by, in epoch ms. */
export async function databaseNow(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ now: number }>("select (extract(epoch from now()) * 1000)::float8 as now");
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("select now() returned no row");
  return now;
}
