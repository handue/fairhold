import { z } from "zod";

import { attachSessionCookie, clientRateLimitKey, jsonOk, postRoute, readJson } from "@/server/api";
import { startDemoGala } from "@/server/demo/start";

const body = z.object({
  firstName: z.string(),
  /** The browser's IANA time zone; anything unrecognized falls back to the gala's own. */
  timeZone: z.string().max(64).nullish(),
});

/**
 * Starts a private demo gala and signs the browser in as its creator: paddle 142, with organizer
 * rights over this event alone. Answers 201 { slug, paddleNumber, firstName, href }, 429
 * rate_limited past 5 per client per hour, or 503 demo_capacity with 25 demos already running.
 */
export const POST = postRoute(async (request) => {
  const { firstName, timeZone } = await readJson(request, body);
  const demo = await startDemoGala({ firstName, timeZone, clientKey: clientRateLimitKey(request, "demo") });
  const response = jsonOk(
    {
      slug: demo.slug,
      paddleNumber: demo.paddleNumber,
      firstName: demo.firstName,
      href: `/e/${encodeURIComponent(demo.slug)}`,
    },
    { status: 201 },
  );
  return attachSessionCookie(response, demo.created);
});
