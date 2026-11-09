import { ApiError, enforceRateLimit, jsonOk, postRoute, requirePaddle } from "@/server/api";
import { skipPlanLot } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";
import { parseLotNumber } from "@/server/queries/request";

/**
 * Glim stops on this lot at once, and bids already placed stand ("Skip the spa"). Answers 200 ChatView,
 * also for a lot already skipped; 404 lot_not_found; 409 not_in_plan or lot_closed.
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/lots/[number]/skip">>(async (request, { params }) => {
  const { slug, number } = await params;
  const session = await requirePaddle(slug, request);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  const lotNumber = parseLotNumber(number);
  if (lotNumber === null) throw new ApiError(404, "lot_not_found", "I can’t find that lot.");
  await skipPlanLot(session, lotNumber);
  return jsonOk(await loadChatView(session));
});
