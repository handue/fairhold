import { z } from "zod";

import {
  attachSessionCookie,
  clientRateLimitKey,
  enforceRateLimit,
  getSession,
  jsonOk,
  postRoute,
  readJson,
} from "@/server/api";
import { joinEvent } from "@/server/sessions/join";

const body = z.object({ firstName: z.string() });

/** A whole table behind one venue's address has to fit; this is only a brake on scripts. */
const JOINS_PER_CLIENT = { limit: 60, windowSeconds: 3_600 };

/**
 * Gives the browser the event's next paddle number. Answers 201 { slug, paddleNumber, firstName,
 * href } and sets the session cookie; 200 with the same fields if this browser already has a
 * paddle here; 403 event_view_only on a seeded event in production; 404 event_not_found; 409
 * event_closed once bidding has ended; 429 rate_limited.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/join">>(async (request, { params }) => {
  const { slug } = await params;
  const { firstName } = await readJson(request, body);
  const session = await getSession(slug, request);
  if (!session?.paddleId) await enforceRateLimit(clientRateLimitKey(request, "join"), JOINS_PER_CLIENT);

  const joined = await joinEvent({ slug, firstName, session });
  const response = jsonOk(
    {
      slug,
      paddleNumber: joined.paddleNumber,
      firstName: joined.firstName,
      href: `/e/${encodeURIComponent(slug)}`,
    },
    { status: joined.created ? 201 : 200 },
  );
  return joined.created ? attachSessionCookie(response, joined.created) : response;
});
