/**
 * The live layer's server side: one LISTEN connection per process, fanned out in memory to every
 * open /api/stream.
 *
 * A NOTIFY only says "something happened in this event". The hub reads the new rows once per event,
 * however many streams are open on it, and hands each stream the rows its viewer may see. Rows stay
 * in server memory until canSeeStreamRow lets one out, so a guest can never receive another paddle's
 * private row.
 *
 * How a stream joins without a gap or a duplicate:
 *   1. Its channel exists before anything is read, so notifications from here on are not lost.
 *   2. LISTEN is up before the replay read, so a commit after the read is always notified.
 *   3. The replay reads up to a fixed position. The stream goes live only once its position has
 *      reached the channel's cursor, in the same synchronous step as the check.
 *   4. Fan-out skips anything at or before the stream's own position.
 *
 * NOTIFY is the fast path, not the only one. The tick reads every channel again on each heartbeat,
 * and a lost LISTEN connection is reopened and caught up, so a dropped notification costs seconds
 * and never a row.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type pg from "pg";

import { getPool, openListenConnection } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { getDatabaseUrl, getDevelopmentSwitches } from "@/server/lib/env";

import { EVENT_LOG_CHANNEL, parseEventLogNotification } from "./notify";
import { databaseNow, existingEventIds, latestPosition, readRowsAfter, readVisibleRows, recentPosition } from "./rows";
import {
  canSeeStreamRow,
  isAfterPosition,
  STREAM_HEARTBEAT_SECONDS,
  STREAM_REPLAY_LIMIT,
  type StreamControlEvent,
  type StreamControlPayloads,
  type StreamEvent,
  type StreamViewer,
} from "./types";

/** Where one open stream writes. */
export interface StreamSink {
  row(row: StreamEvent): void;
  control<Name extends StreamControlEvent>(name: Name, payload: StreamControlPayloads[Name]): void;
  /** Ends the stream; the browser reconnects, and the route answers for the new state of things. */
  end(): void;
}

export interface StreamSubscription {
  eventId: string;
  viewer: StreamViewer;
  paddleNumber: number | null;
  /** Null for a connection with no position, which starts STREAM_RECENT_ROWS behind the newest row. */
  after: string | null;
  sink: StreamSink;
}

export interface StreamHubOptions {
  pool: Queryable;
  /** Opens the dedicated connection. Tests pass one they can break. */
  openListener?: () => Promise<pg.Client>;
  heartbeatMs?: number;
  /** A LISTEN connection that does not answer a ping in this long counts as lost. */
  listenerPingTimeoutMs?: number;
}

interface Subscriber {
  viewer: StreamViewer;
  paddleNumber: number | null;
  sink: StreamSink;
  /** Every row at or before this has been sent, or was not this viewer's to see. */
  position: string;
  closed: boolean;
}

interface Channel {
  eventId: string;
  /** Rows at or before this were fanned out to `live`. Null until the first replay read fixes it. */
  cursor: string | null;
  live: Set<Subscriber>;
  joining: Set<Subscriber>;
  pumping: boolean;
  /** More rows may have committed since the read in progress began. */
  dirty: boolean;
  scheduled: boolean;
}

/** Rows read per round of a channel's fan-out. */
const PUMP_BATCH = 500;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 5_000;

export class StreamHub {
  private readonly channels = new Map<string, Channel>();
  private listener: pg.Client | null = null;
  private listening: Promise<void> | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private tickTimer: NodeJS.Timeout | undefined;
  private ticking = false;
  private clockOffsetMs: number | null = null;
  private closed = false;

  private readonly pool: Queryable;
  private readonly openListener: () => Promise<pg.Client>;
  private readonly heartbeatMs: number;
  private readonly pingTimeoutMs: number;

  constructor(options: StreamHubOptions) {
    this.pool = options.pool;
    this.openListener = options.openListener ?? openStreamListener;
    this.heartbeatMs = options.heartbeatMs ?? STREAM_HEARTBEAT_SECONDS * 1_000;
    this.pingTimeoutMs = options.listenerPingTimeoutMs ?? 5_000;
  }

  /** Opens one stream. Call the returned function when its client goes away. */
  subscribe(subscription: StreamSubscription): () => void {
    const channel = this.channelFor(subscription.eventId);
    const subscriber: Subscriber = {
      viewer: subscription.viewer,
      paddleNumber: subscription.paddleNumber,
      sink: subscription.sink,
      position: subscription.after ?? "0",
      closed: false,
    };
    channel.joining.add(subscriber);
    this.startTicking();
    void this.join(channel, subscriber, subscription.after);
    return () => this.leave(channel, subscriber);
  }

  /** How many streams this process holds open. */
  get subscriberCount(): number {
    let count = 0;
    for (const channel of this.channels.values()) count += channel.live.size + channel.joining.size;
    return count;
  }

  get isListening(): boolean {
    return this.listener !== null;
  }

  /** True from the moment this process starts shutting down. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Ends every stream and the LISTEN connection. Browsers reconnect to whichever process is next. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    for (const channel of [...this.channels.values()]) this.endChannel(channel);
    const listener = this.listener;
    this.listener = null;
    this.listening = null;
    await listener?.end().catch(() => {});
  }

  // Joining ------------------------------------------------------------------------------------

  private channelFor(eventId: string): Channel {
    let channel = this.channels.get(eventId);
    if (!channel) {
      channel = {
        eventId,
        cursor: null,
        live: new Set(),
        joining: new Set(),
        pumping: false,
        dirty: false,
        scheduled: false,
      };
      this.channels.set(eventId, channel);
    }
    return channel;
  }

  private async join(channel: Channel, subscriber: Subscriber, requestedAfter: string | null): Promise<void> {
    try {
      await this.ensureListening();
      const latest = await latestPosition(this.pool, channel.eventId);
      const after = requestedAfter ?? (await recentPosition(this.pool, channel.eventId));
      const serverNow = await this.serverNow();
      if (subscriber.closed) return;

      subscriber.position = after;
      subscriber.sink.control("hello", {
        serverNow,
        paddleId: subscriber.viewer.paddleId,
        paddleNumber: subscriber.paddleNumber,
        isOrganizer: subscriber.viewer.isOrganizer,
        after,
        latest,
      });
      await this.replayAndGoLive(channel, subscriber, latest);
    } catch (error) {
      if (!subscriber.closed) console.error("[stream] could not open a stream:", error);
      subscriber.sink.end();
      this.leave(channel, subscriber);
    }
  }

  private async replayAndGoLive(channel: Channel, subscriber: Subscriber, latest: string): Promise<void> {
    let through = latest;
    for (;;) {
      if (isAfterPosition(through, subscriber.position)) {
        const rows = await readVisibleRows(this.pool, {
          eventId: channel.eventId,
          viewer: subscriber.viewer,
          after: subscriber.position,
          through,
          limit: STREAM_REPLAY_LIMIT + 1,
        });
        if (subscriber.closed) return;
        if (rows.length > STREAM_REPLAY_LIMIT) {
          subscriber.sink.control("resync", { reason: "too_far_behind", position: through });
        } else {
          for (const row of rows) subscriber.sink.row(row);
        }
        subscriber.position = through;
      }

      channel.cursor ??= through;
      if (!isAfterPosition(channel.cursor, subscriber.position)) break;
      // Fan-out went past this stream while it read: read up to where it is now.
      through = channel.cursor;
    }
    channel.joining.delete(subscriber);
    channel.live.add(subscriber);
    if (channel.dirty) this.schedulePump(channel);
  }

  private leave(channel: Channel, subscriber: Subscriber): void {
    subscriber.closed = true;
    channel.live.delete(subscriber);
    channel.joining.delete(subscriber);
    if (channel.live.size + channel.joining.size > 0) return;
    if (this.channels.get(channel.eventId) === channel) this.channels.delete(channel.eventId);
    if (this.channels.size === 0) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  private endChannel(channel: Channel): void {
    for (const subscriber of [...channel.live, ...channel.joining]) {
      subscriber.closed = true;
      subscriber.sink.end();
      this.leave(channel, subscriber);
    }
  }

  // Fan-out ------------------------------------------------------------------------------------

  private schedulePump(channel: Channel): void {
    if (channel.scheduled) return;
    channel.scheduled = true;
    // One transaction's rows arrive as a burst of notifications; this reads them once.
    setImmediate(() => {
      channel.scheduled = false;
      void this.pump(channel);
    });
  }

  private async pump(channel: Channel): Promise<void> {
    if (channel.pumping || channel.cursor === null) {
      channel.dirty = true;
      return;
    }
    channel.pumping = true;
    try {
      do {
        channel.dirty = false;
        const rows = await readRowsAfter(this.pool, channel.eventId, channel.cursor, PUMP_BATCH);
        for (const row of rows) this.fanOut(channel, row);
        if (rows.length === PUMP_BATCH) channel.dirty = true;
      } while (channel.dirty && this.channels.get(channel.eventId) === channel);
    } catch (error) {
      // The tick reads again from the same cursor, so nothing is lost.
      if (!this.closed) console.error("[stream] could not read new rows:", error);
    } finally {
      channel.pumping = false;
    }
  }

  private fanOut(channel: Channel, row: StreamEvent): void {
    channel.cursor = row.id;
    for (const subscriber of channel.live) {
      if (!isAfterPosition(row.id, subscriber.position)) continue;
      subscriber.position = row.id;
      if (canSeeStreamRow(row, subscriber.viewer)) subscriber.sink.row(row);
    }
  }

  // The LISTEN connection ----------------------------------------------------------------------

  private ensureListening(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("The stream hub is closed"));
    this.listening ??= this.startListening().catch((error: unknown) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }

  private async startListening(): Promise<void> {
    const client = await this.openListener();
    client.on("notification", (message) => this.onNotification(message));
    client.on("error", (error) => this.onListenerLost(client, error));
    client.on("end", () => this.onListenerLost(client));
    try {
      await client.query(`LISTEN ${EVENT_LOG_CHANNEL}`);
      if (this.closed) throw new Error("The stream hub is closed");
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
    this.listener = client;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
  }

  private onNotification(message: pg.Notification): void {
    if (message.channel !== EVENT_LOG_CHANNEL) return;
    const notification = parseEventLogNotification(message.payload);
    if (!notification) return;
    const channel = this.channels.get(notification.eventId);
    if (channel) this.schedulePump(channel);
  }

  private onListenerLost(client: pg.Client, error?: Error): void {
    if (this.listener !== client) return;
    this.listener = null;
    this.listening = null;
    if (error && !this.closed) console.error("[stream] lost the LISTEN connection:", error.message);
    void client.end().catch(() => {});
    if (!this.closed && this.channels.size > 0) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed || this.channels.size === 0) return;
      this.ensureListening().then(
        // Anything committed while it was down was not notified; read it now.
        () => this.pumpAll(),
        (error: unknown) => {
          console.error("[stream] could not reopen the LISTEN connection:", error);
          this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
          this.scheduleReconnect();
        },
      );
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private pumpAll(): void {
    for (const channel of this.channels.values()) this.schedulePump(channel);
  }

  // The tick -----------------------------------------------------------------------------------

  private startTicking(): void {
    if (this.tickTimer !== undefined) return;
    this.tickTimer = setInterval(() => void this.tick(), this.heartbeatMs);
    this.tickTimer.unref();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.refreshClock().catch(() => {});
      this.sendHeartbeats(this.currentServerNow());
      // A database that is down must not stop the heartbeats above, only what follows.
      await this.endDeletedEvents().catch(() => {});
      this.pumpAll();
      await this.pingListener();
    } finally {
      this.ticking = false;
    }
  }

  private sendHeartbeats(serverNow: number): void {
    for (const channel of this.channels.values()) {
      for (const subscriber of channel.live) subscriber.sink.control("heartbeat", { serverNow });
    }
  }

  private async endDeletedEvents(): Promise<void> {
    const eventIds = [...this.channels.keys()];
    if (eventIds.length === 0) return;
    const existing = await existingEventIds(this.pool, eventIds);
    for (const eventId of eventIds) {
      const channel = this.channels.get(eventId);
      if (channel && !existing.has(eventId)) this.endChannel(channel);
    }
  }

  private async pingListener(): Promise<void> {
    const listener = this.listener;
    if (!listener) {
      if (this.channels.size > 0 && !this.closed) this.scheduleReconnect();
      return;
    }
    const answered = await Promise.race([
      listener.query("select 1").then(
        () => true,
        () => false,
      ),
      sleep(this.pingTimeoutMs, false, { ref: false }),
    ]);
    if (!answered) this.onListenerLost(listener, new Error("The LISTEN connection stopped answering"));
  }

  // The clock ----------------------------------------------------------------------------------

  private async refreshClock(): Promise<void> {
    this.clockOffsetMs = (await databaseNow(this.pool)) - Date.now();
  }

  private currentServerNow(): number {
    return getDevelopmentSwitches().freezeClockAt ?? Math.round(Date.now() + (this.clockOffsetMs ?? 0));
  }

  /** The clock the pages read: the database's, or FREEZE_CLOCK_AT outside production. */
  private async serverNow(): Promise<number> {
    if (this.clockOffsetMs === null) await this.refreshClock();
    return this.currentServerNow();
  }
}

/** The dedicated connection, named so it can be told apart in pg_stat_activity. */
export const STREAM_LISTENER_NAME = "fairhold-stream";

function openStreamListener(): Promise<pg.Client> {
  const url = new URL(getDatabaseUrl());
  url.searchParams.set("application_name", STREAM_LISTENER_NAME);
  return openListenConnection(url.toString());
}

// Next.js dev re-evaluates modules on every reload; keeping the hub on globalThis keeps it to one
// connection per process, as the production server has.
const processGlobal = globalThis as typeof globalThis & { __fairholdStreamHub?: StreamHub };

/** The process-wide hub, created on first use. */
export function getStreamHub(): StreamHub {
  if (processGlobal.__fairholdStreamHub) return processGlobal.__fairholdStreamHub;
  const hub = new StreamHub({ pool: getPool() });
  processGlobal.__fairholdStreamHub = hub;
  // Next waits for open responses before it exits. Ending the streams lets a deploy finish at once,
  // and browsers reconnect to the new instance with their position.
  process.once("SIGTERM", () => void hub.close());
  return hub;
}

/** Closes the process-wide hub, for test teardown. */
export async function closeStreamHub(): Promise<void> {
  const hub = processGlobal.__fairholdStreamHub;
  processGlobal.__fairholdStreamHub = undefined;
  await hub?.close();
}
