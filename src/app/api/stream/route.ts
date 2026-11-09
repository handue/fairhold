import { ApiError, apiRoute, clientRateLimitKey } from "@/server/api";
import { resolveStreamAudience } from "@/server/sse/audience";
import { claimClientStream } from "@/server/sse/client-streams";
import { getStreamHub } from "@/server/sse/hub";
import { openStreamResponse } from "@/server/sse/response";
import { parseStreamPosition } from "@/server/sse/types";

/** Past this the process answers 503 and browsers fall back to polling. */
const MAX_STREAMS_PER_PROCESS = 1_000;

/**
 * Server-Sent Events for one event: GET /api/stream?slug=<slug>, the public channel plus the
 * viewer's own. A browser's reconnect sends Last-Event-ID and resumes after it; ?after= does the same
 * for a new connection. With neither, it starts a few rows behind the newest (STREAM_RECENT_ROWS).
 * Answers 400 with no slug, 404 for an unknown event, 429 past one client's streams, 503 when full
 * or shutting down. A browser refused here falls back to polling.
 */
export const GET = apiRoute(async (request) => {
  const audience = await resolveStreamAudience(request);
  const hub = getStreamHub();
  // Shutting down: a new stream has nothing to follow, and this connection should not stay open.
  if (hub.isClosed) throw new ApiError(503, "stream_closed", "Live updates are restarting.", null, { connection: "close" });
  if (hub.subscriberCount >= MAX_STREAMS_PER_PROCESS) {
    throw new ApiError(503, "stream_busy", "Live updates are busy right now.", null, { "retry-after": "30" });
  }
  const release = claimClientStream(clientRateLimitKey(request, "stream"));
  if (!release) throw new ApiError(429, "too_many_streams", "Too many live connections from this address.", null, { "retry-after": "30" });
  const after =
    parseStreamPosition(request.headers.get("last-event-id")) ??
    parseStreamPosition(new URL(request.url).searchParams.get("after"));
  try {
    return openStreamResponse(
      hub,
      { eventId: audience.eventId, viewer: audience.viewer, paddleNumber: audience.paddleNumber, after },
      request,
      release,
    );
  } catch (error) {
    release();
    throw error;
  }
});
