import type { ReactNode } from "react";

import { LiveStreamProvider } from "../live/LiveStream";

/**
 * Wraps every page of an event: one live stream per tab, shared by the page and the Glim panel. It
 * connects only when something reads it (src/ui/live/LiveStream.tsx).
 *
 * Do not call useParams() or usePathname() in a provider here: they suspend while Next builds the
 * static shell of a dynamic route, and with no boundary above them `next build` fails. The stream
 * reads the slug when it starts, with eventSlugFromPath(window.location.pathname) from ./event-path.
 */
export function LiveProviders({ children }: { children: ReactNode }) {
  return <LiveStreamProvider>{children}</LiveStreamProvider>;
}
