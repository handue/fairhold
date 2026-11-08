import { requireOrganizer } from "@/server/api";
import { getPool } from "@/server/db/client";
import { ApiError } from "@/server/api/errors";
import { chooseViewer } from "@/server/queries/viewer";
import { getSession, type Session } from "@/server/sessions";

export interface ControlRoomAccess {
  eventId: string;
  /** Null only for the fixture's own control room, outside production. */
  session: Session | null;
}

/**
 * What every settlement route starts with: the same rule as the 12 page (chooseViewer). In production
 * only this event's organizer session passes, with a 401 or 403 for anyone else. Elsewhere the seeded
 * fixture, which has no organizer session, also opens for design checks and tests.
 */
export async function requireControlRoom(slug: string, request: Request): Promise<ControlRoomAccess> {
  const session = await getSession(slug, request);
  const viewer = chooseViewer({ production: process.env.NODE_ENV === "production", slug, paddleParam: null, session });
  if (!viewer.isOrganizer) await requireOrganizer(slug, request);

  const { rows } = await getPool().query<{ id: string }>("select id from events where slug = $1", [slug]);
  const eventId = rows[0]?.id;
  if (!eventId) throw new ApiError(404, "event_not_found", "We couldn’t find that event.");
  return { eventId, session };
}
