"use client";

import type { Instant } from "@/server/queries/types";

import { cn } from "../cn";
import { formatCountdown, isClosingSoon } from "../format";
import { ClockIcon } from "../icons";
import { useServerNow } from "../ServerClock";

/** 08's timer in a row of 10: plain, then the ink pill under ten minutes. */
export function RowTimer({ closesAt }: { closesAt: Instant }) {
  const remaining = closesAt - useServerNow();
  const soon = isClosingSoon(remaining);
  return (
    <span
      className={cn(
        "inline-flex h-30 items-center gap-6 font-mono text-13 whitespace-nowrap tabular-nums",
        soon ? "rounded-full bg-ink pr-11 pl-9 text-white" : "text-ink2",
      )}
    >
      <ClockIcon size={13} />
      <span className="sr-only">Closes in </span>
      {formatCountdown(remaining)}
    </span>
  );
}
