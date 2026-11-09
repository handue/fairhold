/**
 * Who a stream request speaks for. The same rule as the pages (chooseViewer): in production the
 * session cookie decides and nothing else; outside production ?paddle= overrides it, so a page
 * showing a chosen paddle gets that paddle's rows. The slug only says which event; rights over it
 * come from the cookie, which is named after the event.
 */
import { ApiError } from "@/server/api/errors";
import { getPool } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import type { Queryable } from "@/server/db/transaction";
import { getDevelopmentSwitches } from "@/server/lib/env";
import { parsePaddleParam } from "@/server/queries/request";
import { chooseViewer } from "@/server/queries/viewer";
import { getSession } from "@/server/sessions";

import type { StreamViewer } from "./types";

export interface StreamAudience {
  eventId: string;
  slug: string;
  viewer: StreamViewer;
  paddleNumber: number | null;
}

/** Answers 400 with no slug, 404 for an unknown event: the browser stops asking. */
export async function resolveStreamAudience(request: Request, db: Queryable = getPool()): Promise<StreamAudience> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug");
  if (!slug) throw new ApiError(400, "invalid_request", "Say which event to follow.");

  // UI_FIXTURE renders the pages without a database, so there is nothing to stream.
  const notFound = () => new ApiError(404, "event_not_found", "This event doesn’t exist.");
  if (getDevelopmentSwitches().uiFixture !== null || holdsNul(slug)) throw notFound();

  const { rows } = await db.query<{ id: string }>("select id from events where slug = $1", [slug]);
  const eventId = rows[0]?.id;
  if (!eventId) throw notFound();

  const session = await getSession(slug, request, db);
  const chosen = chooseViewer({
    production: process.env.NODE_ENV === "production",
    slug,
    paddleParam: parsePaddleParam(url.searchParams.get("paddle") ?? undefined),
    session,
  });
  const paddleId =
    chosen.paddleNumber !== null && chosen.paddleNumber === session?.paddleNumber
      ? session.paddleId
      : await paddleIdByNumber(db, eventId, chosen.paddleNumber);

  return {
    eventId,
    slug,
    viewer: { paddleId, isOrganizer: chosen.isOrganizer },
    paddleNumber: paddleId === null ? null : chosen.paddleNumber,
  };
}

async function paddleIdByNumber(db: Queryable, eventId: string, paddleNumber: number | null): Promise<string | null> {
  if (paddleNumber === null) return null;
  const { rows } = await db.query<{ id: string }>("select id from paddles where event_id = $1 and number = $2", [
    eventId,
    paddleNumber,
  ]);
  return rows[0]?.id ?? null;
}
