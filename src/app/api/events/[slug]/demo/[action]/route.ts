import {
  ApiError,
  attachSessionCookie,
  clientRateLimitKey,
  enforceRateLimit,
  jsonOk,
  postRoute,
  publicOrigin,
  requireOrganizer,
} from "@/server/api";
import { addTime, closeBiddingNow, closeNextLot, inviteHref, requireDemoEvent, resetDemo } from "@/server/director/controls";
import { sessionCookieHeader } from "@/server/sessions/cookie";

/** Past the 25 running demos, a brake on one browser replacing its own in a loop. */
const RESETS_PER_CLIENT = { limit: 20, windowSeconds: 3_600 };

/**
 * The demo controls, for this event's organizer only, and only on a demo gala. Every failure is the
 * usual envelope: 401 not_joined, 403 organizer_only or demo_only, 404 unknown_control, and 409
 * event_closed once bidding has ended.
 *
 * - close-next-lot: 200 { lotNumber, shortTitle, openLots }
 * - close-bidding: 200 { closedLots, eventClosed }; pressing it again changes nothing
 * - add-time: 200 { closesAt, lots } with ten more minutes; 409 demo_time_limit near the 6-hour limit
 * - invite: 200 { href, url }, the event's join page
 * - reset: 201 { slug, paddleNumber, firstName, href }; ends this gala, voids its real holds and moves
 *   this browser's session to a new gala; 409 settlement_running while charging is under way, 409
 *   demo_already_reset on a press that lost to another, 503 demo_capacity with this gala untouched
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/demo/[action]">>(async (request, { params }) => {
  const { slug, action } = await params;
  const session = await requireOrganizer(slug, request);
  const event = await requireDemoEvent(slug);

  switch (action) {
    case "close-next-lot":
      return jsonOk(await closeNextLot(event));
    case "close-bidding":
      return jsonOk(await closeBiddingNow(event));
    case "add-time": {
      const added = await addTime(event);
      return jsonOk({ closesAt: added.closesAt.toISOString(), lots: added.lots });
    }
    case "invite": {
      const href = inviteHref(event);
      return jsonOk({ href, url: `${publicOrigin(request)}${href}` });
    }
    case "reset": {
      await enforceRateLimit(clientRateLimitKey(request, "demo-reset"), RESETS_PER_CLIENT);
      const demo = await resetDemo({ event, session });
      const response = jsonOk(
        {
          slug: demo.slug,
          paddleNumber: demo.paddleNumber,
          firstName: demo.firstName,
          href: `/e/${encodeURIComponent(demo.slug)}`,
        },
        { status: 201 },
      );
      // The old gala's session goes with the gala, so its cookie can go now.
      response.headers.append("set-cookie", sessionCookieHeader(event.slug, "", 0, process.env.NODE_ENV === "production"));
      return attachSessionCookie(response, demo.created);
    }
    default:
      throw new ApiError(404, "unknown_control", "There is no such demo control.");
  }
});
