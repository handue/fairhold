import { z } from "zod";

import { jsonOk, postRoute, readJson, requirePaddle } from "@/server/api";
import { placeBid } from "@/server/engine";

import { engineFailure, enforceLotActionLimit, refusalError, requireLot } from "../shared";

const body = z.object({ amountCents: z.number().int().positive().max(2_147_483_647) });

/**
 * Places the guest's own bid through the engine. Answers 200 { bid, lot, leading, proxyBids }, or 409
 * with the engine's refusal as code and details (below_minimum, over_bidding_power, no_hold,
 * lot_closed, not_open); 401 not_joined; 404 lot_not_found; 429 rate_limited.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/lots/[number]/bid">>(async (request, { params }) => {
  const { slug, number } = await params;
  const session = await requirePaddle(slug, request);
  const { amountCents } = await readJson(request, body);
  const lot = await requireLot(slug, number);
  await enforceLotActionLimit(session);

  const result = await placeBid(session.paddleId, lot.id, amountCents, "guest").catch((error: unknown) => {
    throw engineFailure(error);
  });
  if (!result.ok) throw refusalError(result.refusal);
  return jsonOk({ bid: result.bid, lot: result.lot, leading: result.leading, proxyBids: result.proxyBids.length });
});
