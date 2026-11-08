/**
 * Writes event_log rows and their change notifications. Every change the live layer shows goes
 * through here, inside the transaction that made the change: the rows and the NOTIFY become
 * visible together at commit, or not at all on rollback.
 *
 * Ordering: event_log.id is the stream position (SSE Last-Event-ID). Sequence values are handed
 * out at insert time, not at commit, so two writers could commit out of id order and a reader
 * could skip a row for good. A per-event advisory lock, held until commit, makes every writer of
 * one event allocate its ids only after the previous writer committed.
 */
import type { SQL } from "drizzle-orm";
import type pg from "pg";

import { positionalSql } from "@/server/db/positional-sql";

import { EVENT_LOG_TYPES, type EventLogType } from "./types";

export { EVENT_LOG_TYPES, type EventLogType };

/** The one channel every process LISTENs on; payloads carry the routing keys. */
export const EVENT_LOG_CHANNEL = "fairhold_event_log";

/** Advisory-lock namespace (first key) for event_log ordering; engine/locks.ts uses others. */
const EVENT_LOG_LOCK_CLASS = 0x4648_0002;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EventLogEntry {
  eventId: string;
  /** Null for the event's public channel; a paddle id for that paddle's own channel. */
  paddleId: string | null;
  type: EventLogType;
  payload: { [key: string]: JsonValue };
}

export interface EventLogRecord {
  /** bigint as a decimal string: the stream position. */
  id: string;
  eventId: string;
  paddleId: string | null;
  type: EventLogType;
  createdAt: Date;
}

/** What a NOTIFY on EVENT_LOG_CHANNEL carries; listeners read the full row from event_log. */
export interface EventLogNotification {
  id: string;
  eventId: string;
  paddleId: string | null;
  type: EventLogType;
}

/** A node-postgres client inside a transaction, or a Drizzle transaction. */
export type EventLogWriter = Pick<pg.ClientBase, "query"> | { execute(query: SQL): Promise<{ rows: unknown[] }> };

interface Statement {
  text: string;
  values: unknown[];
}

interface InsertedRow {
  id: string;
  event_id: string;
  paddle_id: string | null;
  type: EventLogType;
  created_at: Date | string;
}

/**
 * Appends rows to event_log and notifies EVENT_LOG_CHANNEL once per row, in id order.
 * Call it inside a transaction, as the last write before commit: the ordering lock is held from
 * here until the transaction ends.
 */
export async function appendEventLog(
  writer: EventLogWriter,
  entries: readonly EventLogEntry[],
): Promise<EventLogRecord[]> {
  if (entries.length === 0) return [];

  const eventIds = [...new Set(entries.map((entry) => entry.eventId))].sort();
  for (const eventId of eventIds) {
    await run(writer, {
      text: "select pg_advisory_xact_lock($1, hashtext($2))",
      values: [EVENT_LOG_LOCK_CLASS, eventId],
    });
  }

  const rows = await run<InsertedRow>(writer, insertStatement(entries));
  return rows.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    paddleId: row.paddle_id,
    type: row.type,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  }));
}

function insertStatement(entries: readonly EventLogEntry[]): Statement {
  const values: unknown[] = [EVENT_LOG_CHANNEL];
  const tuples = entries.map((entry) => {
    values.push(entry.eventId, entry.paddleId, entry.type, JSON.stringify(entry.payload));
    const last = values.length;
    return `($${last - 3}, $${last - 2}, $${last - 1}, $${last}::jsonb)`;
  });
  return {
    text: `
      with inserted as (
        insert into event_log (event_id, paddle_id, type, payload)
        values ${tuples.join(", ")}
        returning id, event_id, paddle_id, type, created_at
      )
      select id::text as id, event_id, paddle_id, type, created_at,
        pg_notify($1, json_build_object(
          'id', id::text, 'eventId', event_id, 'paddleId', paddle_id, 'type', type
        )::text) as notified
      from inserted
      order by inserted.id`,
    values,
  };
}

// A Drizzle transaction also has a `query` property (its relational query builders), so the
// test is for a query function.
function isPgClient(writer: EventLogWriter): writer is Pick<pg.ClientBase, "query"> {
  return typeof (writer as { query?: unknown }).query === "function";
}

async function run<Row>(writer: EventLogWriter, statement: Statement): Promise<Row[]> {
  if (isPgClient(writer)) {
    const result = await writer.query(statement.text, statement.values);
    return result.rows as Row[];
  }
  const result = await writer.execute(positionalSql(statement.text, statement.values));
  return result.rows as Row[];
}

const EVENT_LOG_TYPE_SET: ReadonlySet<string> = new Set(EVENT_LOG_TYPES);

/** Parses a NOTIFY payload from EVENT_LOG_CHANNEL; null for anything malformed. */
export function parseEventLogNotification(payload: string | undefined): EventLogNotification | null {
  if (!payload) return null;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { id, eventId, paddleId, type } = value as Record<string, unknown>;
  if (typeof id !== "string" || typeof eventId !== "string") return null;
  if (paddleId !== null && typeof paddleId !== "string") return null;
  if (typeof type !== "string" || !EVENT_LOG_TYPE_SET.has(type)) return null;
  return { id, eventId, paddleId, type: type as EventLogType };
}
