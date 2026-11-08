import { enforceRateLimit, jsonOk, postRoute, requirePaddle } from "@/server/api";
import { resumeGlim } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";

/** Glim bids again, answering at once any bid it missed. Answers 200 ChatView (also when not paused), 409 no_plan or event_closed. */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/resume">>(async (request, { params }) => {
  const { slug } = await params;
  const session = await requirePaddle(slug, request);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  await resumeGlim(session);
  return jsonOk(await loadChatView(session));
});
