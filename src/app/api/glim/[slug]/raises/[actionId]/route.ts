import { z } from "zod";

import { ApiError, enforceRateLimit, jsonOk, postRoute, publicOrigin, readJson, requirePaddle } from "@/server/api";
import { raiseOfferAmount } from "@/server/chat/actions";
import { GLIM_ACTIONS_PER_MINUTE } from "@/server/chat/limits";
import { createHold } from "@/server/holds/create";

const body = z.object({
  /** Where the guest goes after approving; createHold accepts only a page of this event. */
  next: z.string().max(2_048).nullish(),
});

/**
 * V3's "Approve $600 in PayPal" (design/21 #9): opens a PayPal window for the raise Glim prepared,
 * for the amount stored on its action and never one this request could send. Answers 201
 * { holdId, amountCents, approvalUrl } like POST /api/holds/[slug]; 404 offer_not_found; 409
 * offer_ended once the offer can no longer be taken; and createHold's own refusals.
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/raises/[actionId]">>(async (request, { params }) => {
  const { slug, actionId } = await params;
  const session = await requirePaddle(slug, request);
  const { next } = await readJson(request, body);
  await enforceRateLimit(`glim_actions:${session.paddleId}`, GLIM_ACTIONS_PER_MINUTE);
  if (!z.uuid().safeParse(actionId).success) throw new ApiError(404, "offer_not_found", "I can’t find that offer.");
  const amountCents = await raiseOfferAmount(session, actionId);
  const hold = await createHold({ paddleId: session.paddleId, amountCents, origin: publicOrigin(request), next });
  return jsonOk(hold, { status: 201 });
});
