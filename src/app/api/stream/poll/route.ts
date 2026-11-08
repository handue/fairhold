import { apiRoute, jsonOk } from "@/server/api";
import { resolveStreamAudience } from "@/server/sse/audience";
import { readPollAnswer } from "@/server/sse/poll";
import { parseStreamPosition } from "@/server/sse/types";

/**
 * The stream's fallback: GET /api/stream/poll?slug=<slug>&after=<position> answers the same rows as
 * JSON (StreamPollResponse), for a browser that could not keep a stream open. 404 for an unknown
 * event, which is also how a browser learns why its stream was refused.
 */
export const GET = apiRoute(async (request) => {
  const audience = await resolveStreamAudience(request);
  const after = parseStreamPosition(new URL(request.url).searchParams.get("after"));
  return jsonOk(await readPollAnswer(audience.eventId, audience.viewer, after));
});
