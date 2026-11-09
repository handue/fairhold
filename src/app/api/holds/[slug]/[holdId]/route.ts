import { ApiError, apiRoute, jsonOk, requirePaddle } from "@/server/api";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";

/**
 * The status of this browser's own hold, for the page that opened its PayPal window. Answers 200
 * { holdId, status, amountCents }; 401 not_joined; 404 hold_not_found, also for another guest's hold.
 */
export const GET = apiRoute<RouteContext<"/api/holds/[slug]/[holdId]">>(async (request, { params }) => {
  const { slug, holdId } = await params;
  const session = await requirePaddle(slug, request);
  const hold = await createPostgresHoldStore().findHold(holdId);
  if (hold?.paddleId !== session.paddleId) throw new ApiError(404, "hold_not_found", "We could not find this hold.");
  return jsonOk({ holdId: hold.id, status: hold.status, amountCents: hold.amountCents });
});
