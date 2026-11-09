import { ApiError, apiRoute, enforceRateLimit, jsonOk, postRoute } from "@/server/api";
import { requireControlRoom } from "@/server/settlement/access";
import { getLedgerView, kickSettlementQueue, startSettlement } from "@/server/settlement";

/** Starting costs a PayPal read per real hold, so a stuck key cannot run them up. */
const STARTS_PER_EVENT = { limit: 30, windowSeconds: 60 };

async function ledgerOf(slug: string) {
  const view = await getLedgerView(slug);
  if (!view) throw new ApiError(404, "event_not_found", "We couldn’t find that event.");
  return view;
}

/**
 * 12's ledger, with no call to PayPal. Answers the LedgerView; 401 not_joined, 403 organizer_only.
 * While a settlement runs each read also nudges the queue, so charging goes on after a restart even
 * where the engine tick is off.
 */
export const GET = apiRoute<RouteContext<"/api/events/[slug]/settlement">>(async (request, { params }) => {
  const { slug } = await params;
  await requireControlRoom(slug, request);
  const view = await ledgerOf(slug);
  if (view.settlement?.status === "running") kickSettlementQueue();
  return jsonOk(view);
});

/**
 * "Charge N winners". Idempotent: a double click gets the same settlement. Answers the LedgerView;
 * 409 bidding_open while bidding runs; 409 event_ended for a demo that was retired; 409 checks_failed,
 * with the checks in details, when one fails and nothing moved.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/settlement">>(async (request, { params }) => {
  const { slug } = await params;
  const { eventId, session } = await requireControlRoom(slug, request);
  await enforceRateLimit(`settlement-start:${eventId}`, STARTS_PER_EVENT);

  const started = await startSettlement({ eventId, startedBySessionId: session?.id ?? null });
  if (started.kind === "bidding_open") {
    throw new ApiError(409, "bidding_open", "Bidding is still open, so there is nothing to charge yet.");
  }
  if (started.kind === "event_ended") {
    throw new ApiError(409, "event_ended", "This event has ended, and its holds were released.");
  }
  if (started.kind === "checks_failed") {
    throw new ApiError(409, "checks_failed", "A check failed, so nothing was charged.", { checks: started.checks });
  }
  kickSettlementQueue();
  return jsonOk(await ledgerOf(slug));
});
