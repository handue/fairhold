import { enforceRateLimit, jsonOk, postRoute, requirePaddle } from "@/server/api";
import { pauseGlim } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";

/** No new Glim bids until Resume; bids stand. Answers 200 ChatView (also when already paused), 409 no_plan or event_closed. */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/pause">>(async (request, { params }) => {
  const { slug } = await params;
  const session = await requirePaddle(slug, request);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  await pauseGlim(session);
  return jsonOk(await loadChatView(session));
});
