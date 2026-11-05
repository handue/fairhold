"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";

import type { Instant } from "@/server/queries/types";

/**
 * Countdowns run on the server's clock, not the browser's. The page passes the server time it
 * rendered at; from hydration on, the clock advances by the browser's elapsed time, one shared
 * tick per second for every countdown on the page.
 */
interface ServerClock {
  subscribe(onTick: () => void): () => void;
  getSnapshot(): Instant;
  getServerSnapshot(): Instant;
}

function createServerClock(serverNow: Instant): ServerClock {
  const listeners = new Set<() => void>();
  let now = serverNow;
  let timer: ReturnType<typeof setInterval> | undefined;
  /** The browser's time when the page first subscribed, standing in for when it rendered. */
  let startedAt: number | undefined;

  return {
    subscribe(onTick) {
      listeners.add(onTick);
      if (timer === undefined) {
        const origin = (startedAt ??= Date.now());
        timer = setInterval(() => {
          now = serverNow + (Date.now() - origin);
          for (const listener of listeners) listener();
        }, 1_000);
      }
      return () => {
        listeners.delete(onTick);
        if (listeners.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
    getSnapshot: () => now,
    // Hydration renders at the server's time, so the first client render matches the HTML.
    getServerSnapshot: () => serverNow,
  };
}

const ServerClockContext = createContext<ServerClock | null>(null);

export function ServerClockProvider({ serverNow, children }: { serverNow: Instant; children: ReactNode }) {
  const clock = useMemo(() => createServerClock(serverNow), [serverNow]);
  return <ServerClockContext value={clock}>{children}</ServerClockContext>;
}

/** The server's current time, updated every second. */
export function useServerNow(): Instant {
  const clock = useContext(ServerClockContext);
  if (!clock) throw new Error("useServerNow needs a ServerClockProvider above it.");
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getServerSnapshot);
}
