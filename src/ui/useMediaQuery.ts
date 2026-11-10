"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current as the window changes. False on the server and in the
 * first render after it, so what the server sent stays the desktop's; the browser's answer follows.
 * For what CSS can't reach, such as a grid's column widths; layout itself stays in the max-* variants.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Below 1440, where the approved boards stop. */
export const BELOW_DESK_QUERY = "(width < 90rem)";
/** Below 768: a phone. */
export const PHONE_QUERY = "(width < 48rem)";
/** Below 1024: a phone or a tablet. */
export const TABLET_QUERY = "(width < 64rem)";