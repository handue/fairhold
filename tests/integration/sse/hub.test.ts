/** The hub on its own, with a heartbeat short enough to watch and a LISTEN connection a test can break. */
import { afterEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import type { Queryable } from "@/server/db/transaction";
import { StreamHub, type StreamSink } from "@/server/sse/hub";
import { appendEventLog, EVENT_LOG_CHANNEL } from "@/server/sse/notify";
import type { StreamControlEvent, StreamControlPayloads, StreamEvent } from "@/server/sse/types";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

import { until } from "./support";

const { pool, url } = getTestDatabase();

class Collector implements StreamSink {
  rows: StreamEvent[] = [];
  controls: { name: StreamControlEvent; payload: unknown }[] = [];
  ended = false;
  row(row: StreamEvent) {
    this.rows.push(row);
  }
  control<Name extends StreamControlEvent>(name: Name, payload: StreamControlPayloads[Name]) {
    this.controls.push({ name, payload });
  }
  end() {
    this.ended = true;
  }
  get beats() {
    return this.controls.filter((control) => control.name === "heartbeat").length;
  }
  get saidHello() {
    return this.controls.some((control) => control.name === "hello");
  }
}

const hubs: StreamHub[] = [];
function hub(options: Partial<ConstructorParameters<typeof StreamHub>[0]> = {}): StreamHub {
  const created = new StreamHub({ pool, openListener: () => connect(), heartbeatMs: 50, ...options });
  hubs.push(created);
  return created;
}

async function connect(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url, application_name: "hub-test" });
  await client.connect();
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(hubs.splice(0).map((created) => created.close()));
});

async function subscribed(target: StreamHub, eventId: string, viewer = { paddleId: null, isOrganizer: false } as { paddleId: string | null; isOrganizer: boolean }) {
  const sink = new Collector();
  const stop = target.subscribe({ eventId, viewer, paddleNumber: null, after: null, sink });
  await until(() => sink.saidHello);
  // The move to live follows the replay read.
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { sink, stop };
}

const publicRow = (eventId: string) => ({
  eventId,
  paddleId: null,
  type: "event_status" as const,
  payload: { kind: "event_settled", status: "settled" },
});

/** The hub's own pool, with one kind of read held back until a test lets it go. */
function poolHolding(matches: (text: string) => boolean) {
  let release = () => {};
  let held: Promise<void> | null = new Promise((resolve) => {
    release = resolve;
  });
  let waiting = 0;
  const gated = {
    query: async (text: string, values?: unknown[]) => {
      if (held && matches(text)) {
        waiting += 1;
        await held;
      }
      return pool.query(text, values);
    },
  } as unknown as Queryable;
  return {
    gated,
    waiting: () => waiting,
    letGo() {
      held = null;
      release();
    },
  };
}

const isFanOutRead = (text: string) => text.includes("id > $2::bigint order by");
const isReplayRead = (text: string) => text.includes("id <= $3::bigint");

describe("how a stream joins a channel in motion", () => {
  it("does not repeat a row it replayed when fan-out reaches that row afterwards", async () => {
    const eventId = await createEvent(pool);
    const holding = poolHolding(isFanOutRead);
    const target = hub({ pool: holding.gated, heartbeatMs: 60_000 });
    const first = await subscribed(target, eventId);

    // The notification arrives, and the fan-out's read is held back.
    const [row] = await appendEventLog(pool, [publicRow(eventId)]);
    await until(() => holding.waiting() > 0);

    // A second stream replays the row and goes live, with the channel's cursor still behind it.
    const second = await subscribed(target, eventId);
    await until(() => second.sink.rows.some((item) => item.id === row?.id));

    holding.letGo();
    await until(() => first.sink.rows.some((item) => item.id === row?.id));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.sink.rows.map((item) => item.id)).toEqual([row?.id]);
    expect(first.sink.rows.map((item) => item.id)).toEqual([row?.id]);
  });

  it("does not miss a row fan-out sent while it was still replaying", async () => {
    const eventId = await createEvent(pool);
    await appendEventLog(pool, [publicRow(eventId)]);
    const target = hub({ heartbeatMs: 60_000 });
    const first = await subscribed(target, eventId);

    // A second stream starts, and its replay read is held back. It has fixed where its replay ends.
    const holding = poolHolding(isReplayRead);
    (target as unknown as { pool: Queryable }).pool = holding.gated;
    const second = new Collector();
    target.subscribe({ eventId, viewer: { paddleId: null, isOrganizer: false }, paddleNumber: null, after: null, sink: second });
    await until(() => holding.waiting() > 0);

    // Meanwhile a row commits and goes out to the stream that is already live.
    const [row] = await appendEventLog(pool, [publicRow(eventId)]);
    await until(() => first.sink.rows.some((item) => item.id === row?.id));

    holding.letGo();
    await until(() => second.rows.some((item) => item.id === row?.id));
    expect(second.rows.filter((item) => item.id === row?.id)).toHaveLength(1);
  });

  it("keeps a late stream's first read from hiding rows, however many it joins behind", async () => {
    const eventId = await createEvent(pool);
    const target = hub({ heartbeatMs: 60_000 });
    const early = await subscribed(target, eventId);
    const written = [];
    for (let index = 0; index < 5; index += 1) written.push(...(await appendEventLog(pool, [publicRow(eventId)])));
    const late = await subscribed(target, eventId);
    written.push(...(await appendEventLog(pool, [publicRow(eventId)])));

    const ids = written.map((row) => row.id);
    await until(() => early.sink.rows.length === ids.length && late.sink.rows.length === ids.length);
    expect(early.sink.rows.map((row) => row.id)).toEqual(ids);
    expect(late.sink.rows.map((row) => row.id)).toEqual(ids);
  });
});

describe("StreamHub", () => {
  it("sends a heartbeat to every open stream", async () => {
    const eventId = await createEvent(pool);
    const target = hub();
    const first = await subscribed(target, eventId);
    const second = await subscribed(target, eventId);
    await until(() => first.sink.beats >= 2 && second.sink.beats >= 2);
    const beat = first.sink.controls.find((control) => control.name === "heartbeat");
    expect((beat?.payload as { serverNow: number }).serverNow).toBeGreaterThan(0);
  });

  it("delivers a row whose notification never came, on the next heartbeat", async () => {
    const eventId = await createEvent(pool);
    // A connection that claims to listen and hears nothing.
    const deaf = async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      client.query = ((text: string, ...rest: unknown[]) =>
        text.startsWith("LISTEN") ? Promise.resolve({ rows: [] }) : query(text, ...rest)) as typeof client.query;
      return client;
    };
    const target = hub({ openListener: deaf });
    const { sink } = await subscribed(target, eventId);

    const [written] = await appendEventLog(pool, [publicRow(eventId)]);
    await until(() => sink.rows.some((row) => row.id === written?.id));
  });

  it("reopens a lost LISTEN connection and delivers what committed while it was down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = await createEvent(pool);
    const clients: pg.Client[] = [];
    const target = hub({
      heartbeatMs: 60_000,
      openListener: async () => {
        const client = await connect();
        clients.push(client);
        return client;
      },
    });
    const { sink } = await subscribed(target, eventId);
    const pid = (await clients[0]?.query<{ pid: number }>("select pg_backend_pid() as pid"))?.rows[0]?.pid;

    await pool.query("select pg_terminate_backend($1)", [pid]);
    const [duringOutage] = await appendEventLog(pool, [publicRow(eventId)]);
    await until(() => sink.rows.some((row) => row.id === duringOutage?.id));
    await until(() => target.isListening);
    expect(clients).toHaveLength(2);

    const [afterwards] = await appendEventLog(pool, [publicRow(eventId)]);
    await until(() => sink.rows.some((row) => row.id === afterwards?.id));
    expect(sink.ended).toBe(false);
  });

  it("treats a LISTEN connection that stopped answering as lost", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = await createEvent(pool);
    const clients: pg.Client[] = [];
    const target = hub({
      listenerPingTimeoutMs: 20,
      openListener: async () => {
        const client = await connect();
        clients.push(client);
        if (clients.length === 1) {
          // Answers LISTEN, then goes quiet, as a half-open connection does.
          const query = client.query.bind(client) as (...args: unknown[]) => unknown;
          client.query = ((text: string, ...rest: unknown[]) =>
            text.startsWith("LISTEN") ? query(text, ...rest) : new Promise(() => {})) as typeof client.query;
        }
        return client;
      },
    });
    await subscribed(target, eventId);
    await until(() => clients.length === 2 && target.isListening);
  });

  it("ends the streams of an event that was deleted, so browsers learn it is gone", async () => {
    const eventId = await createEvent(pool);
    const otherId = await createEvent(pool);
    const target = hub();
    const { sink } = await subscribed(target, eventId);
    const other = await subscribed(target, otherId);

    await pool.query("delete from events where id = $1", [eventId]);
    await until(() => sink.ended);
    expect(target.subscriberCount).toBe(1);
    expect(other.sink.ended).toBe(false);
  });

  it("ends a stream it could not open, rather than leaving it silent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const eventId = await createEvent(pool);
    const target = hub({ openListener: () => Promise.reject(new Error("no connections left")) });
    const sink = new Collector();
    target.subscribe({ eventId, viewer: { paddleId: null, isOrganizer: false }, paddleNumber: null, after: null, sink });
    await until(() => sink.ended);
    expect(target.subscriberCount).toBe(0);
  });

  it("ends every stream on close, and refuses new ones", async () => {
    const eventId = await createEvent(pool);
    const target = hub();
    const { sink } = await subscribed(target, eventId);
    await target.close();
    expect(sink.ended).toBe(true);
    expect(target.isListening).toBe(false);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const late = new Collector();
    target.subscribe({ eventId, viewer: { paddleId: null, isOrganizer: false }, paddleNumber: null, after: null, sink: late });
    await until(() => late.ended);
  });

  it("stops sending to a stream as soon as it leaves", async () => {
    const eventId = await createEvent(pool);
    const paddleId = await createPaddle(pool, eventId, 7);
    const target = hub();
    const { sink, stop } = await subscribed(target, eventId, { paddleId, isOrganizer: false });
    stop();
    await appendEventLog(pool, [publicRow(eventId)]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sink.rows).toHaveLength(0);
    expect(target.subscriberCount).toBe(0);
  });

  it("listens on the channel the writers notify", async () => {
    const queries: string[] = [];
    const eventId = await createEvent(pool);
    const target = hub({
      openListener: async () => {
        const client = await connect();
        const query = client.query.bind(client) as (...args: unknown[]) => unknown;
        client.query = ((text: string, ...rest: unknown[]) => {
          queries.push(text);
          return query(text, ...rest);
        }) as typeof client.query;
        return client;
      },
    });
    await subscribed(target, eventId);
    expect(queries[0]).toBe(`LISTEN ${EVENT_LOG_CHANNEL}`);
  });
});
