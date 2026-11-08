import { cookies } from "next/headers";
import { cache } from "react";

import { FIXTURE_SLUG } from "@/server/demo/template";
import { getDevelopmentSwitches } from "@/server/lib/env";
import { getSession, type Session } from "@/server/sessions";

import { DEFAULT_VIEWER_PADDLE } from "./request";

export { indexViewerLots, summarizeViewer, viewerLotStatus, type ViewerLots } from "./viewer-summary";

/** Who is looking at a page of one event. */
export interface Viewer {
  /** The paddle the page shows; null for a visitor with no paddle here, whom guest pages send to join. */
  paddleNumber: number | null;
  /** The ?paddle= override, for links to carry along. Never set in production. */
  linkPaddle: number | null;
  /** This browser's session in the event, if it has one. */
  session: Session | null;
  /** Organizer rights over this event. */
  isOrganizer: boolean;
}

/**
 * The rule, on its own so it can be tested. In production the session decides, and nothing else.
 * Elsewhere ?paddle= picks a viewer for tests and design checks, and the seeded fixture falls back
 * to the approved viewer: Jamie, who also sees the fixture's control room. Any other event treats
 * a browser without a session as a visitor everywhere, so a second browser can join a demo locally.
 */
export function chooseViewer(input: {
  production: boolean;
  slug: string;
  paddleParam: number | null;
  session: Session | null;
}): Viewer {
  const { production, slug, paddleParam, session } = input;
  const isOrganizer = session?.isOrganizer ?? false;
  if (production) return { paddleNumber: session?.paddleNumber ?? null, linkPaddle: null, session, isOrganizer };
  if (paddleParam !== null) return { paddleNumber: paddleParam, linkPaddle: paddleParam, session, isOrganizer };
  if (session) return { paddleNumber: session.paddleNumber, linkPaddle: null, session, isOrganizer };
  const isFixture = slug === FIXTURE_SLUG;
  return { paddleNumber: isFixture ? DEFAULT_VIEWER_PADDLE : null, linkPaddle: null, session: null, isOrganizer: isFixture };
}

/**
 * The viewer of the current request, read once per request: pass the parsed ?paddle= from a page
 * (parsePaddleParam), or null from a layout slot. Call it inside a <Suspense> boundary, because it
 * reads the cookie.
 */
export const resolveViewer = cache(async (slug: string, paddleParam: number | null): Promise<Viewer> => {
  // UI_FIXTURE renders without a database, so there is no session to look up.
  const session = getDevelopmentSwitches().uiFixture === null ? await getSession(slug, await cookies()) : null;
  return chooseViewer({ production: process.env.NODE_ENV === "production", slug, paddleParam, session });
});
