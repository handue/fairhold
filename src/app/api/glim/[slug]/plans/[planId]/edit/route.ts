import { z } from "zod";

import { ApiError, enforceRateLimit, jsonOk, postRoute, readJson, requirePaddle } from "@/server/api";
import { editPlan } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { loadChatView } from "@/server/chat/view";

const body = z.object({
  /** The plan's new lots in the guest's order; a lot left out is dropped. */
  items: z
    .array(z.object({ lotNumber: z.number().int().positive().max(9_999), maxCents: z.number().int().positive().max(100_000_000) }))
    .min(1)
    .max(12),
});

/**
 * New maximums for a plan: code checks them like any proposal and answers with a new card for Start
 * bidding, and nothing changes until then. Answers 200 ChatView, 404 plan_not_found, 409
 * plan_not_proposed, or 422 with the rule that broke and every issue in details.
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/plans/[planId]/edit">>(async (request, { params }) => {
  const { slug, planId } = await params;
  const session = await requirePaddle(slug, request);
  const { items } = await readJson(request, body);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  if (!z.uuid().safeParse(planId).success) throw new ApiError(404, "plan_not_found", "I can’t find that plan.");
  await editPlan(session, planId, items);
  return jsonOk(await loadChatView(session));
});
