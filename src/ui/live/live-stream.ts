/**
 * The browser's end of /api/stream, with no React in it. One LiveStream per event per tab. It keeps
 * the rows it has seen, in order, so a page can fold them over the data it was rendered with, and it
 * says how far back those rows reach, so a page knows when they no longer cover it.
 *
 * It starts when the first consumer subscribes and stops a minute after the last one leaves, so a
 * page that shows nothing live opens no connection. Its position survives a stop.
 *
 * Failures, in order: the browser's own EventSource retries with Last-Event-ID; after
 * STREAM_POLL_AFTER_FAILURES in a row the stream gives way to polling every STREAM_POLL_SECONDS, and
 * keeps trying to come back. An EventSource refused by the server (a 404 for an unknown event) closes
 * for good and cannot say why, so a poll asks: a 404 there stops everything.
 */
import {
  EVENT_LOG_TYPES,
  isAfterPosition,
  STREAM_HEARTBEAT_SECONDS,
  STREAM_POLL_AFTER_FAILURES,
  STREAM_POLL_SECONDS,
  type StreamControlPayloads,
  type StreamEvent,
  type StreamPollResponse,
} from "@/server/sse/types";
import { eventSlugFromPath } from "@/ui/event/event-path";

export type StreamStatus =
  /** Not started, or stopped with no consumers. */
  | "idle"
  | "connecting"
  | "live"
  /** Falling back to polling while it tries to get a stream back. */
  | "polling"
  /** The event does not exist (any more). Nothing retries. */
  | "gone";

export interface ClockSample {
  /** The server's clock when the sample was taken, epoch ms. */
  serverNow: number;
  /** The browser's clock at the same moment. */
  receivedAt: number;
}

export interface LiveStreamState {
  /** Rows seen, oldest first, up to MAX_ROWS. */
  rows: readonly StreamEvent[];
  /** `rows` holds every row this viewer may see after this position. Null before the first answer. */
  coverage: string | null;
  status: StreamStatus;
  /** Set on each new connection, so countdowns can correct themselves. */
  clock: ClockSample | null;
  /** Counts the times rows were lost for good, after which a page must read its data again. */
  resyncs: number;
}

export const INITIAL_STREAM_STATE: LiveStreamState = {
  rows: [],
  coverage: null,
  status: "idle",
  clock: null,
  resyncs: 0,
};

/** The part of EventSource this file uses, so tests can pass their own. */
export interface EventSourceLike {
  readonly readyState: number;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export const EVENT_SOURCE_CLOSED = 2;

export type PollAnswer = { status: number; body: StreamPollResponse | null };

export interface LiveStreamEnvironment {
  /** The event and any ?paddle= of the current page, read when the stream starts. */
  location(): { slug: string | null; paddle: string | null };
  openEventSource(url: string): EventSourceLike;
  fetchPoll(url: string): Promise<PollAnswer>;
  /** Calls `listener` when reconnecting now is worthwhile; returns how to stop. */
  onWake?(listener: () => void): () => void;
}

/** Rows kept. A page further behind than this reads its data again. */
export const MAX_ROWS = 2_000;
/** Frames in one burst, like a replay, reach the page together. */
const FLUSH_MS = 16;
/** Keeps the connection across a navigation between pages. */
const IDLE_STOP_MS = 60_000;
/** Two silent heartbeats, and some slack. */
const WATCHDOG_MS = (2 * STREAM_HEARTBEAT_SECONDS + 5) * 1_000;
/** How often polling tries to get a stream back. */
const STREAM_RETRY_MS = 30_000;
const MAX_BACKOFF_MS = 15_000;

export class LiveStream {
  private state: LiveStreamState = INITIAL_STREAM_STATE;
  private readonly stateListeners = new Set<() => void>();
  private readonly rowListeners = new Set<(row: StreamEvent) => void>();

  private consumers = 0;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private slug: string | null = null;
  private paddle: string | null = null;

  private source: EventSourceLike | null = null;
  private failures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private streamRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private stopWaking: (() => void) | undefined;

  /** Rows at or before this were received or skipped: what the next connection asks to follow. */
  private cursor: string | null = null;
  private newestRow = "0";
  /** Rows up to here are the replay of a first connection: history to fold, not news to announce. */
  private historyThrough = "0";
  private pending: StreamEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly environment: LiveStreamEnvironment = browserEnvironment()) {}

  getState = (): LiveStreamState => this.state;

  /** For useSyncExternalStore. Subscribing is what keeps the stream open. */
  subscribe = (listener: () => void): (() => void) => {
    this.stateListeners.add(listener);
    this.retain();
    return () => {
      this.stateListeners.delete(listener);
      this.release();
    };
  };

  /** Calls `listener` with each new row, never with the history a first connection replays. */
  onRow(listener: (row: StreamEvent) => void): () => void {
    this.rowListeners.add(listener);
    this.retain();
    return () => {
      this.rowListeners.delete(listener);
      this.release();
    };
  }

  /** After the guest's own action: while polling, there is no need to wait for the next poll. */
  pollNow(): void {
    if (this.polling) void this.poll();
  }

  // Starting and stopping ----------------------------------------------------------------------

  private retain(): void {
    this.consumers += 1;
    clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    if (!this.started && this.state.status !== "gone") this.start();
  }

  private release(): void {
    this.consumers -= 1;
    if (this.consumers > 0) return;
    this.stopTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
  }

  private start(): void {
    const { slug, paddle } = this.environment.location();
    if (!slug) return;
    this.started = true;
    this.slug = slug;
    this.paddle = paddle;
    this.failures = 0;
    this.stopWaking = this.environment.onWake?.(() => this.wake());
    this.connect();
  }

  private stop(): void {
    this.started = false;
    this.closeTransport();
    this.stopWaking?.();
    this.stopWaking = undefined;
    this.flush();
    if (this.state.status !== "gone") this.setState({ status: "idle" });
  }

  private closeTransport(): void {
    this.closeSource();
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pollTimer);
    clearTimeout(this.streamRetryTimer);
    this.polling = false;
  }

  private giveUp(): void {
    this.closeTransport();
    this.stopWaking?.();
    this.stopWaking = undefined;
    this.started = false;
    this.flush();
    this.setState({ status: "gone" });
  }

  /** The browser came back online or the tab came back: try now instead of waiting out a backoff. */
  private wake(): void {
    if (!this.started || this.state.status === "live") return;
    if (this.source === null) this.connect();
    this.pollNow();
  }

  // The stream ---------------------------------------------------------------------------------

  private url(path: string): string {
    const query = new URLSearchParams({ slug: this.slug ?? "" });
    if (this.cursor !== null) query.set("after", this.cursor);
    if (this.paddle !== null) query.set("paddle", this.paddle);
    return `${path}?${query.toString()}`;
  }

  private connect(): void {
    this.closeSource();
    clearTimeout(this.reconnectTimer);
    if (!this.polling) this.setState({ status: "connecting" });

    const source = this.environment.openEventSource(this.url("/api/stream"));
    this.source = source;
    const current = <Payload>(run: (payload: Payload) => void) => (event: MessageEvent<string>) => {
      if (source !== this.source) return;
      this.armWatchdog();
      run(JSON.parse(event.data) as Payload);
    };
    source.addEventListener("hello", current<StreamControlPayloads["hello"]>((hello) => this.onHello(hello)));
    source.addEventListener("heartbeat", current<StreamControlPayloads["heartbeat"]>(() => {}));
    source.addEventListener("resync", current<StreamControlPayloads["resync"]>(({ position }) => this.resync(position)));
    for (const type of EVENT_LOG_TYPES) {
      source.addEventListener(type, current<StreamEvent>((row) => this.receive(row)));
    }
    source.onerror = () => {
      if (source === this.source) this.onSourceError(source);
    };
    this.armWatchdog();
  }

  private closeSource(): void {
    clearTimeout(this.watchdogTimer);
    this.source?.close();
    this.source = null;
  }

  private armWatchdog(): void {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => this.onSilence(), WATCHDOG_MS);
  }

  /** A connection a proxy stalled without closing: nothing but silence says it is dead. */
  private onSilence(): void {
    this.failures += 1;
    if (this.failures >= STREAM_POLL_AFTER_FAILURES) {
      this.closeSource();
      this.enterPolling();
    } else {
      this.connect();
    }
  }

  private onHello(hello: StreamControlPayloads["hello"]): void {
    const firstAnswer = this.state.coverage === null;
    this.failures = 0;
    if (this.polling) this.leavePolling();
    if (firstAnswer) this.historyThrough = hello.latest;
    // A browser's own retry sends Last-Event-ID only once a row has arrived. Without one, the server
    // starts this connection a few rows back, and that can be past where this tab stopped.
    if (this.cursor !== null && isAfterPosition(hello.after, this.cursor)) this.resync(hello.after);
    this.cursor ??= hello.after;
    this.setState({
      status: "live",
      coverage: this.state.coverage ?? hello.after,
      clock: { serverNow: hello.serverNow, receivedAt: Date.now() },
    });
  }

  private onSourceError(source: EventSourceLike): void {
    this.failures += 1;
    if (this.failures >= STREAM_POLL_AFTER_FAILURES) {
      this.closeSource();
      this.enterPolling();
      return;
    }
    if (source.readyState !== EVENT_SOURCE_CLOSED) return; // The browser is already retrying.
    this.closeSource();
    void this.poll();
    this.reconnectTimer = setTimeout(() => this.connect(), Math.min(1_000 * 2 ** (this.failures - 1), MAX_BACKOFF_MS));
  }

  // Polling ------------------------------------------------------------------------------------

  private enterPolling(): void {
    clearTimeout(this.reconnectTimer);
    if (!this.polling) {
      this.polling = true;
      this.setState({ status: "polling" });
      void this.poll();
    }
    clearTimeout(this.streamRetryTimer);
    this.streamRetryTimer = setTimeout(() => this.connect(), STREAM_RETRY_MS);
  }

  private leavePolling(): void {
    this.polling = false;
    clearTimeout(this.pollTimer);
    clearTimeout(this.streamRetryTimer);
  }

  private async poll(): Promise<void> {
    clearTimeout(this.pollTimer);
    const asked = this.url("/api/stream/poll");
    let answer: PollAnswer | null = null;
    try {
      answer = await this.environment.fetchPoll(asked);
    } catch {
      // Offline, or the server is restarting: the next poll tries again.
    }
    if (!this.started) return;
    if (answer?.status === 404) {
      this.giveUp();
      return;
    }
    if (answer?.body) this.applyPollAnswer(answer.body);
    if (this.polling) this.pollTimer = setTimeout(() => void this.poll(), STREAM_POLL_SECONDS * 1_000);
  }

  private applyPollAnswer(answer: StreamPollResponse): void {
    if (answer.resync) {
      this.resync(answer.position);
      return;
    }
    const firstAnswer = this.state.coverage === null;
    for (const row of answer.rows) this.receive(row);
    if (!this.cursor || isAfterPosition(answer.position, this.cursor)) this.cursor = answer.position;
    if (firstAnswer) {
      this.historyThrough = answer.position;
      this.setState({
        coverage: answer.after,
        clock: this.state.clock ?? { serverNow: answer.serverNow, receivedAt: Date.now() },
      });
    }
  }

  // Rows ---------------------------------------------------------------------------------------

  private receive(row: StreamEvent): void {
    if (!isAfterPosition(row.id, this.newestRow)) return;
    this.newestRow = row.id;
    this.cursor = row.id;
    this.pending.push(row);
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const fresh = this.pending;
    this.pending = [];

    const rows = [...this.state.rows, ...fresh];
    const overflow = rows.length - MAX_ROWS;
    const lastDropped = overflow > 0 ? rows[overflow - 1] : undefined;
    this.setState({
      rows: overflow > 0 ? rows.slice(overflow) : rows,
      coverage: lastDropped ? lastDropped.id : this.state.coverage,
    });
    for (const row of fresh) {
      if (!isAfterPosition(row.id, this.historyThrough)) continue;
      for (const listener of this.rowListeners) listener(row);
    }
  }

  /** Rows were skipped for good. Nothing kept can bridge the gap, so the page reads again. */
  private resync(position: string): void {
    this.pending = [];
    this.newestRow = position;
    this.cursor = position;
    this.setState({ rows: [], coverage: position, resyncs: this.state.resyncs + 1 });
  }

  private setState(change: Partial<LiveStreamState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.stateListeners) listener();
  }
}

function browserEnvironment(): LiveStreamEnvironment {
  return {
    location: () => ({
      slug: eventSlugFromPath(window.location.pathname),
      paddle: new URLSearchParams(window.location.search).get("paddle"),
    }),
    openEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
    async fetchPoll(url) {
      const response = await fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!response.ok) return { status: response.status, body: null };
      return { status: response.status, body: (await response.json()) as StreamPollResponse };
    },
    onWake(listener) {
      const whenVisible = () => {
        if (document.visibilityState === "visible") listener();
      };
      window.addEventListener("online", listener);
      document.addEventListener("visibilitychange", whenVisible);
      return () => {
        window.removeEventListener("online", listener);
        document.removeEventListener("visibilitychange", whenVisible);
      };
    },
  };
}
