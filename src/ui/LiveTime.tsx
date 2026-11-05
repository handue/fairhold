"use client";

import type { Instant } from "@/server/queries/types";

import { formatCountdown, formatTimeAgo } from "./format";
import { useServerNow } from "./ServerClock";

/** "18:42" until closesAt, on the server's clock. */
export function Countdown({ closesAt, className }: { closesAt: Instant; className?: string }) {
  const now = useServerNow();
  return <span className={className}>{formatCountdown(closesAt - now)}</span>;
}

/** "2 min ago", refreshed as the minutes pass. */
export function TimeAgo({ at, className }: { at: Instant; className?: string }) {
  const now = useServerNow();
  return <span className={className}>{formatTimeAgo(now - at)}</span>;
}
