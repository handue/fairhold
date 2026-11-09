"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { foldStreamRows, type LiveRecords } from "@/server/queries/live-records";
import type { Instant } from "@/server/queries/types";
import { isAfterPosition, type EventLogType, type StreamEvent } from "@/server/sse/types";

import { LiveStream, type LiveStreamState } from "./live-stream";

/*
 * The live layer for React. The event layout puts one LiveStream around every page of an event
 * (src/ui/event/LiveProviders.tsx). Anything under it can then:
 *
 *   const records = useLiveRecords(seed);      // a page's rows, kept current from the stream
 *   useStreamEvent((row) => { ... });          // run something on each new row
 *   useLiveRefresh((row) => row.type === "hold");   // re-render the server's page on matching rows
 *   <LiveRefresh types={["settlement"]} />     // the same, from a server component
 *
 * Reading any of these is what opens the connection. A page that reads none opens none.
 */

const StreamContext = createContext<LiveStream | null>(null);

export function LiveStreamProvider({ children }: { children: ReactNode }) {
  const [stream] = useState(() => new LiveStream());
  return <StreamContext value={stream}>{children}</StreamContext>;
}

/** Outside an event there is no slug, so this one never connects. */
const NO_STREAM = new LiveStream({
  location: () => ({ slug: null, paddle: null }),
  openEventSource: () => {
    throw new Error("No event to follow");
  },
  fetchPoll: () => Promise.reject(new Error("No event to follow")),
});

export function useLiveStream(): LiveStream {
  return useContext(StreamContext) ?? NO_STREAM;
}

const NO_ROWS: readonly StreamEvent[] = [];

function useStreamState<Value>(select: (state: LiveStreamState) => Value, serverValue: Value): Value {
  const stream = useLiveStream();
  return useSyncExternalStore(
    stream.subscribe,
    () => select(stream.getState()),
    () => serverValue,
  );
}

/** How often a page that has fallen behind what the stream still holds asks for its data again. */
const CATCH_UP_RETRY_MS = 5_000;

/**
 * A page's rows with every stream row after their position applied. When the stream no longer holds
 * all of those (a long sleep, or more rows than it keeps), or the event is gone, it asks the server
 * for the page again.
 */
export function useLiveRecords<Records extends LiveRecords>(seed: Records): Records {
  const rows = useStreamState((state) => state.rows, NO_ROWS);
  const coverage = useStreamState((state) => state.coverage, null);
  const gone = useStreamState((state) => state.status === "gone", false);
  const router = useRouter();

  const behind = coverage !== null && isAfterPosition(coverage, seed.streamPosition);
  useEffect(() => {
    if (!behind && !gone) return;
    router.refresh();
    if (!behind) return;
    const retry = setInterval(() => router.refresh(), CATCH_UP_RETRY_MS);
    return () => clearInterval(retry);
  }, [behind, gone, router]);

  return useMemo(() => foldStreamRows(seed, rows), [seed, rows]);
}

/**
 * The instant to give ServerClockProvider. A page starts from the time it was rendered, which it
 * hydrates some time after; each new connection then says what the server's clock reads.
 */
export function useLiveServerNow(renderedAt: Instant): Instant {
  const clock = useStreamState((state) => state.clock, null);
  const [mountedAt] = useState(() => Date.now());
  if (clock === null) return renderedAt;
  // A connection opened before this page mounted: its reading has aged by the difference.
  return clock.serverNow + Math.max(0, mountedAt - clock.receivedAt);
}

/** Runs `listener` on each new row while mounted; never on a first connection's replayed history. */
export function useStreamEvent(listener: (row: StreamEvent) => void): void {
  const stream = useLiveStream();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => stream.onRow((row) => latest.current(row)), [stream]);
}

/** Rows arriving together refresh the page once. */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Re-renders the server's page when a matching row arrives, or after rows were lost for good: the
 * way for a screen with no fold of its own to stay current. The server reads fresh, so this is
 * always right, and costs one render of the page per burst.
 */
export function useLiveRefresh(matches: (row: StreamEvent) => boolean): void {
  const router = useRouter();
  const resyncs = useStreamState((state) => state.resyncs, 0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const refreshSoon = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
  };
  useStreamEvent((row) => {
    if (matches(row)) refreshSoon();
  });

  useEffect(() => {
    if (resyncs > 0) router.refresh();
  }, [resyncs, router]);
  useEffect(() => () => clearTimeout(timer.current), []);
}

/** useLiveRefresh for a server component's page: `<LiveRefresh types={["hold", "settlement"]} />`. */
export function LiveRefresh({ types }: { types: readonly EventLogType[] }) {
  useLiveRefresh((row) => types.includes(row.type));
  return null;
}
