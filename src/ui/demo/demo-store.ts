/**
 * Who is looking at a demo gala, for the navs' role menu. The navs are drawn by each screen, inside
 * the screen's own client tree, while the event layout's demo slot is the one place that reads the
 * session for every page. The slot publishes here and the paddle and organizer pills read it, so no
 * screen has to pass anything along. Browser only: the server never publishes, so a server render
 * always draws the plain pill, and the menu arrives with hydration. Its trigger looks the same.
 */
import { useSyncExternalStore } from "react";

export interface DemoRole {
  slug: string;
  /** The demo's creator: organizer rights over this gala, and the demo controls. */
  isOrganizer: boolean;
  /** The gala's time zone, for "Bidding now closes at 9:40 PM." */
  timeZone: string;
}

let current: DemoRole | null = null;
const listeners = new Set<() => void>();

export function publishDemoRole(role: DemoRole | null): void {
  if (role === current) return;
  current = role;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The role published for this gala, or null: another gala, a visitor, or not hydrated yet. */
export function useDemoRole(slug: string): DemoRole | null {
  return useSyncExternalStore(
    subscribe,
    () => (current?.slug === slug ? current : null),
    () => null,
  );
}
