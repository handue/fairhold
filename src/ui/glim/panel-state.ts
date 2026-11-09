/**
 * Whether Glim's panel is open, for the corner's orb and its invitation, which live in each page while
 * the panel lives in the event layout. A tiny store rather than a provider, so a server component can
 * render the corner without one above it.
 */
import { useSyncExternalStore } from "react";

import { openGlim } from "../glim-events";

let open = false;
let talked = false;

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function setGlimPanelOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  notify();
}

/** The guest has written to Glim, so the corner stops inviting them to. */
export function setGuestTalked(next: boolean): void {
  if (talked === next) return;
  talked = next;
  notify();
}

export function useGlimPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}

/**
 * A corner bubble never shows over the open panel, and the invitation to talk to Glim only until the
 * guest has. Other bubbles (a receipt's pickup note, say) stay for those who have.
 */
export function useGlimBubbleVisible({ invitation }: { invitation: boolean }): boolean {
  return useSyncExternalStore(subscribe, () => !open && !(invitation && talked), () => true);
}

/** The orb: opens the panel, or closes it when it is open. */
export function toggleGlimPanel(): void {
  if (open) setGlimPanelOpen(false);
  else openGlim();
}
