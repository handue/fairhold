/**
 * The browser's end of the stream, with a fake EventSource and fake timers: rows in order and once,
 * what a page learns about how far they reach, and each step of falling back and coming back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STREAM_POLL_AFTER_FAILURES, STREAM_POLL_SECONDS, type StreamEvent, type StreamPollResponse } from "@/server/sse/types";
import {
  EVENT_SOURCE_CLOSED,
  LiveStream,
  MAX_ROWS,
  type EventSourceLike,
  type LiveStreamEnvironment,
  type PollAnswer,
} from "@/ui/live/live-stream";

const CONNECTING = 0;
const OPEN = 1;

class FakeEventSource implements EventSourceLike {
  readyState = OPEN;
  closed = false;
  onerror: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }

  emit(type: string, data: unknown) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }

  hello(fields: Partial<{ after: string; latest: string; serverNow: number }> = {}) {
    this.emit("hello", {
      serverNow: 5_000_000,
      paddleId: "p1",
      paddleNumber: 142,
      isOrganizer: false,
      after: "100",
      latest: "100",
      ...fields,
    });
  }

  fail(readyState = CONNECTING) {
    this.readyState = readyState;
    this.onerror?.(new Event("error"));
  }
}

const row = (id: number): StreamEvent =>
  ({
    id: String(id),
    type: "bid",
    paddleId: null,
    at: 1_000,
    payload: { kind: "outbid" },
  }) as unknown as StreamEvent;

interface Harness {
  stream: LiveStream;
  sources: FakeEventSource[];
  source(): FakeEventSource;
  polls: string[];
  answerPoll: (url: string) => Promise<PollAnswer>;
  notifications: number;
}

function harness(overrides: Partial<LiveStreamEnvironment> = {}): Harness {
  const self: Harness = {
    stream: undefined as unknown as LiveStream,
    sources: [],
    source() {
      const source = self.sources.at(-1);
      if (!source) throw new Error("no connection was opened");
      return source;
    },
    polls: [],
    answerPoll: () => Promise.reject(new Error("offline")),
    notifications: 0,
  };
  self.stream = new LiveStream({
    location: () => ({ slug: "gala-1", paddle: null }),
    openEventSource(url) {
      const source = new FakeEventSource(url);
      self.sources.push(source);
      return source;
    },
    fetchPoll(url) {
      self.polls.push(url);
      return self.answerPoll(url);
    },
    ...overrides,
  });
  return self;
}

function connected(): Harness {
  const self = harness();
  self.stream.subscribe(() => {
    self.notifications += 1;
  });
  self.source().hello();
  return self;
}

const pollAnswer = (fields: Partial<StreamPollResponse> = {}): PollAnswer => ({
  status: 200,
  body: { serverNow: 7_000_000, after: "100", position: "100", rows: [], resync: false, ...fields },
});

const flush = () => vi.advanceTimersByTimeAsync(20);

/** Time passing on a healthy connection. */
async function heartbeatsFor(self: Harness, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 15_000) {
    await vi.advanceTimersByTimeAsync(15_000);
    self.source().emit("heartbeat", { serverNow: 1 });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("starting", () => {
  it("opens nothing until something reads it", () => {
    const self = harness();
    expect(self.sources).toHaveLength(0);
    expect(self.stream.getState().status).toBe("idle");
    self.stream.subscribe(() => {});
    expect(self.sources).toHaveLength(1);
    expect(self.source().url).toBe("/api/stream?slug=gala-1");
    expect(self.stream.getState().status).toBe("connecting");
  });

  it("opens one connection however many read it", () => {
    const self = harness();
    self.stream.subscribe(() => {});
    self.stream.subscribe(() => {});
    self.stream.onRow(() => {});
    expect(self.sources).toHaveLength(1);
  });

  it("never connects with no event in the address", () => {
    const self = harness({ location: () => ({ slug: null, paddle: null }) });
    self.stream.subscribe(() => {});
    expect(self.sources).toHaveLength(0);
    expect(self.stream.getState().status).toBe("idle");
  });

  it("carries a test viewer's ?paddle= along", () => {
    const self = harness({ location: () => ({ slug: "gala-1", paddle: "88" }) });
    self.stream.subscribe(() => {});
    expect(self.source().url).toBe("/api/stream?slug=gala-1&paddle=88");
  });

  it("reads the first answer: live, how far back it reaches, and the server's clock", () => {
    const self = connected();
    expect(self.stream.getState()).toMatchObject({
      status: "live",
      coverage: "100",
      clock: { serverNow: 5_000_000, receivedAt: 1_000_000 },
    });
  });
});

describe("rows", () => {
  it("keeps them in order and hands a burst over at once", async () => {
    const self = connected();
    const before = self.notifications;
    for (const id of [101, 102, 103]) self.source().emit("bid", row(id));
    expect(self.stream.getState().rows).toHaveLength(0);
    await flush();
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["101", "102", "103"]);
    expect(self.notifications).toBe(before + 1);
  });

  it("drops a row it has already seen, whichever way it came", async () => {
    const self = connected();
    self.source().emit("bid", row(101));
    self.source().emit("bid", row(101));
    self.source().emit("bid", row(100));
    await flush();
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["101"]);
  });

  it("announces news to listeners, never a first connection's history", async () => {
    const self = harness();
    const heard: string[] = [];
    self.stream.onRow((item) => heard.push(item.id));
    self.source().hello({ after: "90", latest: "100" });
    self.source().emit("bid", row(99));
    self.source().emit("bid", row(100));
    self.source().emit("bid", row(101));
    await flush();
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["99", "100", "101"]);
    expect(heard).toEqual(["101"]);
  });

  it("announces what a reconnect replays, which is news to this tab", async () => {
    const self = connected();
    const heard: string[] = [];
    self.stream.onRow((item) => heard.push(item.id));
    self.source().emit("bid", row(101));
    await flush();

    self.source().fail();
    self.source().hello({ after: "101", latest: "103" });
    self.source().emit("bid", row(102));
    await flush();
    expect(heard).toEqual(["101", "102"]);
  });

  it("forgets the oldest past its limit, and says how far back it still reaches", async () => {
    const self = connected();
    for (let id = 101; id <= 100 + MAX_ROWS + 3; id += 1) self.source().emit("bid", row(id));
    await flush();
    const { rows, coverage } = self.stream.getState();
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[0]?.id).toBe("104");
    expect(coverage).toBe("103");
  });

  it("reads a new connection that starts past this tab's position as lost rows", async () => {
    const self = connected();
    self.source().fail(CONNECTING);
    self.source().hello({ after: "500", latest: "600" });
    expect(self.stream.getState()).toMatchObject({ status: "live", coverage: "500", resyncs: 1 });

    // A connection that starts at or before its position has lost nothing.
    self.source().fail(CONNECTING);
    self.source().hello({ after: "400", latest: "600" });
    expect(self.stream.getState()).toMatchObject({ coverage: "500", resyncs: 1 });
  });

  it("takes a resync: rows gone, coverage moved, and the page told to read again", async () => {
    const self = connected();
    self.source().emit("bid", row(101));
    await flush();
    self.source().emit("resync", { reason: "too_far_behind", position: "5000" });
    expect(self.stream.getState()).toMatchObject({ rows: [], coverage: "5000", resyncs: 1 });

    self.source().emit("bid", row(4_000));
    self.source().emit("bid", row(5_001));
    await flush();
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["5001"]);
  });
});

describe("failing and falling back", () => {
  it("leaves a dropped connection to the browser's own retry, then carries on", async () => {
    const self = connected();
    self.source().fail(CONNECTING);
    expect(self.sources).toHaveLength(1);
    self.source().readyState = OPEN;
    self.source().hello({ after: "100" });
    expect(self.stream.getState().status).toBe("live");
  });

  it("asks the poll why when the server refuses, and stops for good on a 404", async () => {
    const self = harness();
    self.answerPoll = async () => ({ status: 404, body: null });
    self.stream.subscribe(() => {});
    self.source().fail(EVENT_SOURCE_CLOSED);
    await vi.advanceTimersByTimeAsync(0);

    expect(self.polls).toEqual(["/api/stream/poll?slug=gala-1"]);
    expect(self.stream.getState().status).toBe("gone");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(self.sources).toHaveLength(1);
    expect(self.polls).toHaveLength(1);
  });

  it("opens a new connection with its position after a refusal that was not a 404", async () => {
    const self = connected();
    self.source().emit("bid", row(101));
    await flush();
    self.answerPoll = async () => pollAnswer({ position: "101", after: "101" });
    self.source().fail(EVENT_SOURCE_CLOSED);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(self.sources).toHaveLength(2);
    expect(self.source().url).toBe("/api/stream?slug=gala-1&after=101");
  });

  it("falls back to polling after repeated failures, with the rows arriving the same way", async () => {
    const self = connected();
    self.answerPoll = async () => pollAnswer({ position: "102", rows: [row(101), row(102)] });
    for (let failure = 0; failure < STREAM_POLL_AFTER_FAILURES; failure += 1) self.source().fail(CONNECTING);
    await flush();

    expect(self.stream.getState().status).toBe("polling");
    expect(self.source().closed).toBe(true);
    expect(self.polls).toEqual(["/api/stream/poll?slug=gala-1&after=100"]);
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["101", "102"]);

    self.answerPoll = async () => pollAnswer({ position: "103", rows: [row(103)] });
    await vi.advanceTimersByTimeAsync(STREAM_POLL_SECONDS * 1_000);
    expect(self.polls.at(-1)).toBe("/api/stream/poll?slug=gala-1&after=102");
    await flush();
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["101", "102", "103"]);
  });

  it("keeps trying to get a stream back, and stops polling once it does", async () => {
    const self = connected();
    self.answerPoll = async () => pollAnswer();
    for (let failure = 0; failure < STREAM_POLL_AFTER_FAILURES; failure += 1) self.source().fail(CONNECTING);
    await flush();
    const connections = self.sources.length;

    await vi.advanceTimersByTimeAsync(30_000);
    expect(self.sources).toHaveLength(connections + 1);
    expect(self.stream.getState().status).toBe("polling");

    // This attempt fails too: it stays on polling and tries again later.
    self.source().fail(EVENT_SOURCE_CLOSED);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(self.sources).toHaveLength(connections + 2);

    self.source().hello({ after: "100" });
    expect(self.stream.getState().status).toBe("live");
    const polls = self.polls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(self.polls).toHaveLength(polls);
  });

  it("answers the first poll like a first connection when no stream ever opened", async () => {
    const self = harness();
    self.stream.subscribe(() => {});
    self.answerPoll = async () => pollAnswer({ after: "90", position: "95", rows: [row(95)] });
    const heard: string[] = [];
    self.stream.onRow((item) => heard.push(item.id));
    for (let failure = 0; failure < STREAM_POLL_AFTER_FAILURES; failure += 1) self.source().fail(CONNECTING);
    await flush();

    expect(self.stream.getState()).toMatchObject({ status: "polling", coverage: "90", clock: { serverNow: 7_000_000 } });
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["95"]);
    expect(heard).toEqual([]);
  });

  it("takes a resync from a poll", async () => {
    const self = connected();
    self.answerPoll = async () => pollAnswer({ position: "9000", resync: true });
    for (let failure = 0; failure < STREAM_POLL_AFTER_FAILURES; failure += 1) self.source().fail(CONNECTING);
    await flush();
    expect(self.stream.getState()).toMatchObject({ coverage: "9000", resyncs: 1 });
  });

  it("polls right away when asked to, after the guest's own action", async () => {
    const self = connected();
    self.answerPoll = async () => pollAnswer();
    for (let failure = 0; failure < STREAM_POLL_AFTER_FAILURES; failure += 1) self.source().fail(CONNECTING);
    await flush();
    const polls = self.polls.length;
    self.stream.pollNow();
    expect(self.polls).toHaveLength(polls + 1);
  });

  it("does nothing on a request to poll while the stream is up", () => {
    const self = connected();
    self.stream.pollNow();
    expect(self.polls).toHaveLength(0);
  });

  it("reconnects from its position when a stalled connection goes silent", async () => {
    const self = connected();
    self.source().emit("bid", row(101));
    await flush();

    await vi.advanceTimersByTimeAsync(34_000);
    expect(self.sources).toHaveLength(1);
    self.source().emit("heartbeat", { serverNow: 1 });
    await vi.advanceTimersByTimeAsync(34_000);
    expect(self.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(self.sources).toHaveLength(2);
    expect(self.sources[0]?.closed).toBe(true);
    expect(self.source().url).toBe("/api/stream?slug=gala-1&after=101");
  });

  it("ignores a stale connection's frames", async () => {
    const self = connected();
    const old = self.source();
    self.answerPoll = async () => pollAnswer();
    old.fail(EVENT_SOURCE_CLOSED);
    await vi.advanceTimersByTimeAsync(1_000);
    old.emit("bid", row(150));
    await flush();
    expect(self.stream.getState().rows).toHaveLength(0);
  });

  it("wakes up when the browser comes back online", async () => {
    let wake = () => {};
    const self = harness({
      onWake(listener) {
        wake = listener;
        return () => {};
      },
    });
    self.answerPoll = async () => pollAnswer();
    self.stream.subscribe(() => {});
    self.source().fail(EVENT_SOURCE_CLOSED);
    await vi.advanceTimersByTimeAsync(0);
    expect(self.sources).toHaveLength(1);

    wake();
    expect(self.sources).toHaveLength(2);
  });
});

describe("stopping", () => {
  it("keeps the connection across a page change, and closes it when nothing is left", async () => {
    const self = harness();
    const stop = self.stream.subscribe(() => {});
    self.source().hello();
    stop();
    await heartbeatsFor(self, 30_000);
    expect(self.source().closed).toBe(false);

    const again = self.stream.subscribe(() => {});
    await heartbeatsFor(self, 120_000);
    expect(self.sources).toHaveLength(1);
    expect(self.source().closed).toBe(false);

    again();
    await heartbeatsFor(self, 60_000);
    expect(self.source().closed).toBe(true);
    expect(self.stream.getState().status).toBe("idle");
  });

  it("picks up from its position when it starts again", async () => {
    const self = harness();
    const stop = self.stream.subscribe(() => {});
    self.source().hello();
    self.source().emit("bid", row(101));
    await flush();
    stop();
    await heartbeatsFor(self, 60_000);

    self.stream.subscribe(() => {});
    expect(self.sources).toHaveLength(2);
    expect(self.source().url).toBe("/api/stream?slug=gala-1&after=101");
    expect(self.stream.getState().rows.map((item) => item.id)).toEqual(["101"]);
  });

  it("stays gone", async () => {
    const self = harness();
    self.answerPoll = async () => ({ status: 404, body: null });
    self.stream.subscribe(() => {});
    self.source().fail(EVENT_SOURCE_CLOSED);
    await vi.advanceTimersByTimeAsync(0);
    self.stream.subscribe(() => {});
    expect(self.sources).toHaveLength(1);
    expect(self.stream.getState().status).toBe("gone");
  });
});
