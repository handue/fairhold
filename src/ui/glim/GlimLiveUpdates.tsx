"use client";

import { useEffect, useRef } from "react";

import type { StreamEvent } from "@/server/sse/types";

import { useStreamEvent } from "../live/LiveStream";

/** Rows arriving together read the chat once. */
const COALESCE_MS = 250;
/** A row can be missed in a sleeping tab; the panel still catches up on its own. */
const SAFETY_READ_MS = 30_000;

/** Whether this row can change what the open panel shows. */
export function rowChangesChat(row: StreamEvent, watchedLotIds: ReadonlySet<string>): boolean {
  switch (row.type) {
    case "glim":
    case "hold":
    case "lot_closed":
    case "event_status":
      return true;
    case "bid":
      // A plan card's "Winning at $320" follows its own lots, not every bid in the room.
      return row.payload.kind === "bids_placed" && watchedLotIds.has(row.payload.lotId);
    default:
      return false;
  }
}

/**
 * Keeps the open panel current while it is idle: it reads once when mounted, then whenever the stream
 * says something changed. Mounted only then, so a closed panel keeps no connection of its own, and a
 * turn or a button's request has the new view in its own answer.
 */
export function GlimLiveUpdates({ refresh, watchedLotIds }: { refresh: () => Promise<void>; watchedLotIds: ReadonlySet<string> }) {
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    void refresh();
    const safety = setInterval(() => void refresh(), SAFETY_READ_MS);
    return () => {
      clearInterval(safety);
      clearTimeout(pending.current);
    };
  }, [refresh]);

  useStreamEvent((row) => {
    if (!rowChangesChat(row, watchedLotIds) || pending.current !== undefined) return;
    pending.current = setTimeout(() => {
      pending.current = undefined;
      void refresh();
    }, COALESCE_MS);
  });

  return null;
}
