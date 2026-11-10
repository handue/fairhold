import { z } from "zod";

import { ApiError, enforceRateLimit, jsonOk, postRoute, requirePaddle } from "@/server/api";
import { dismissRaise } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";

/**
 * V3's "Not now" (design/21 #10): the raise Glim prepared ends, and its card reads "This offer
 * ended". Answers 200 ChatView, also when the offer had already ended; 404 offer_not_found.
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/raises/[actionId]/dismiss">>(async (request, { params }) => {
  const { slug, actionId } = await params;
  const session = await requirePaddle(slug, request);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  if (!z.uuid().safeParse(actionId).success) throw new ApiError(404, "offer_not_found", "I can’t find that offer.");
  await dismissRaise(session, actionId);
  return jsonOk(await loadChatView(session));
});
