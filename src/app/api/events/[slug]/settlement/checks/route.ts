import { ApiError, enforceRateLimit, jsonOk, postRoute } from "@/server/api";
import { requireControlRoom } from "@/server/settlement/access";
import { getLedgerView, runSettlementChecks } from "@/server/settlement";

/** Each run reads every real hold from PayPal, so reloading the page cannot run them up. */
const RUNS_PER_EVENT = { limit: 30, windowSeconds: 60 };

/**
 * The checks before charging, with a GET to PayPal for each real hold. A POST because it can
 * reauthorize a hold past its honor period. Answers { checks }; 409 bidding_open while bidding runs.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/settlement/checks">>(async (request, { params }) => {
  const { slug } = await params;
  const { eventId } = await requireControlRoom(slug, request);
  const view = await getLedgerView(slug);
  if (view?.phase === "live") {
    throw new ApiError(409, "bidding_open", "The checks run once bidding has closed.");
  }
  // Once a settlement started, its checks are the ones it ran. A retired demo has nothing left to ask.
  if (view?.settlement || view?.phase === "ended") return jsonOk({ checks: view.checks });

  await enforceRateLimit(`settlement-checks:${eventId}`, RUNS_PER_EVENT);
  return jsonOk({ checks: await runSettlementChecks(eventId) });
});
