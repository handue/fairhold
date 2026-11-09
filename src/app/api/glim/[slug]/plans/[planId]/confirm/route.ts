import { z } from "zod";

import { ApiError, enforceRateLimit, jsonOk, postRoute, requirePaddle } from "@/server/api";
import { startBidding } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";

/**
 * Start bidding on a plan card: its limits and opening bids, all or nothing within the hold. Answers
 * 200 ChatView, 404 plan_not_found, or 409 with the reason it can't start (plan_not_proposed, no_hold,
 * over_bidding_power, below_minimum, lot_closed, not_open, plan_invalid).
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/plans/[planId]/confirm">>(async (request, { params }) => {
  const { slug, planId } = await params;
  const session = await requirePaddle(slug, request);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  if (!z.uuid().safeParse(planId).success) throw new ApiError(404, "plan_not_found", "I can’t find that plan.");
  await startBidding(session, planId);
  return jsonOk(await loadChatView(session));
});
