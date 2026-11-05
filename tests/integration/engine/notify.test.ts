import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";
import { describe, expect, it } from "vitest";

import { getDb, openListenConnection } from "@/server/db/client";
import { appendEventLog, EVENT_LOG_CHANNEL, parseEventLogNotification } from "@/server/sse/notify";

import { getTestDatabase } from "../../helpers/database";

import { createEvent } from "./support/fixtures";

const { pool, url } = getTestDatabase();

async function inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>, commit = true): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query(commit ? "commit" : "rollback");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function listen(eventId: string) {
  const listener = await openListenConnection(url);
  const ids: string[] = [];
  listener.on("notification", (message) => {
    const note = parseEventLogNotification(message.payload);
    if (note?.eventId === eventId) ids.push(note.id);
  });
  await listener.query(`listen ${EVENT_LOG_CHANNEL}`);
  return { ids, close: () => listener.end() };
}

describe("appendEventLog", () => {
  it("notifies only once the transaction commits, and never on rollback", async () => {
    const eventId = await createEvent(pool);
    const listener = await listen(eventId);
    try {
      await inTransaction(
        (client) => appendEventLog(client, [{ eventId, paddleId: null, type: "bid", payload: { kind: "dropped" } }]),
        false,
      );
      const records = await inTransaction((client) =>
        appendEventLog(client, [
          { eventId, paddleId: null, type: "bid", payload: { kind: "first" } },
          { eventId, paddleId: null, type: "lot_closed", payload: { kind: "second" } },
        ]),
      );
      await expect.poll(() => listener.ids.length).toBe(2);
      expect(listener.ids).toEqual(records.map((record) => record.id));
      expect(BigInt(records[1]?.id ?? 0)).toBeGreaterThan(BigInt(records[0]?.id ?? 0));
      const { rows } = await pool.query("select 1 from event_log where event_id = $1 and payload->>'kind' = 'dropped'", [
        eventId,
      ]);
      expect(rows).toHaveLength(0);
    } finally {
      await listener.close();
    }
  });

  it("writes through a Drizzle transaction too", async () => {
    const eventId = await createEvent(pool);
    const records = await getDb().transaction((tx) =>
      appendEventLog(tx, [{ eventId, paddleId: null, type: "hold", payload: { kind: "hold_authorized", cents: 50_000 } }]),
    );
    expect(records).toEqual([
      { id: expect.stringMatching(/^\d+$/), eventId, paddleId: null, type: "hold", createdAt: expect.any(Date) },
    ]);
    const { rows } = await pool.query<{ payload: unknown }>("select payload from event_log where id = $1", [records[0]?.id]);
    expect(rows[0]?.payload).toEqual({ kind: "hold_authorized", cents: 50_000 });
  });

  it("hands out stream positions in commit order within an event", async () => {
    const eventId = await createEvent(pool);
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = inTransaction(async (client) => {
      const [record] = await appendEventLog(client, [{ eventId, paddleId: null, type: "bid", payload: { kind: "first" } }]);
      await firstMayCommit;
      order.push("first committed");
      return record;
    });
    await sleep(100);
    const second = inTransaction(async (client) => {
      const [record] = await appendEventLog(client, [{ eventId, paddleId: null, type: "bid", payload: { kind: "second" } }]);
      order.push("second appended");
      return record;
    });
    await sleep(200);
    expect(order).toEqual([]);
    releaseFirst();
    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect(order).toEqual(["first committed", "second appended"]);
    expect(BigInt(secondRecord?.id ?? 0)).toBeGreaterThan(BigInt(firstRecord?.id ?? 0));
  });
});
