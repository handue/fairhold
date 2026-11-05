"use client";

import type { Instant } from "@/server/queries/types";

import { cn } from "../cn";
import { formatCountdown, isClosingSoon } from "../format";
import { ClockIcon } from "../icons";
import { useServerNow } from "../ServerClock";

/** The countdown in a lot tile's corner; it turns into an ink pill under ten minutes. */
export function TileTimer({ closesAt }: { closesAt: Instant }) {
  const remaining = closesAt - useServerNow();
  const soon = isClosingSoon(remaining);

  return (
    <span
      className={cn(
        "absolute top-12 flex h-30 items-center gap-6 font-mono text-13 tabular-nums",
        soon ? "right-12 rounded-full bg-ink pr-11 pl-9 text-white" : "right-14 text-ink2",
      )}
    >
      <ClockIcon size={13} />
      <span className="sr-only">Closes in </span>
      {formatCountdown(remaining)}
    </span>
  );
}
