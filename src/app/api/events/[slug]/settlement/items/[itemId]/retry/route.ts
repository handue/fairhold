import { ApiError, jsonOk, postRoute } from "@/server/api";
import { requireControlRoom } from "@/server/settlement/access";
import { getLedgerView, kickSettlementQueue, retrySettlementItem } from "@/server/settlement";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Retry on a failed row: the charge or release goes back on the queue. Safe to double-click, since
 * only a failed or waiting row moves. Answers the LedgerView; 404 item_not_found.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/settlement/items/[itemId]/retry">>(async (request, { params }) => {
  const { slug, itemId } = await params;
  const { eventId } = await requireControlRoom(slug, request);
  const notFound = () => new ApiError(404, "item_not_found", "We couldn’t find that row.");
  if (!UUID.test(itemId)) throw notFound();

  const retried = await retrySettlementItem(eventId, itemId);
  if (retried.kind === "not_found") throw notFound();
  if (retried.kind === "queued") kickSettlementQueue();
  return jsonOk(await getLedgerView(slug));
});
