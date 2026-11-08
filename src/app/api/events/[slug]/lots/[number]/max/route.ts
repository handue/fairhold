import { z } from "zod";

import { jsonOk, postRoute, readJson, requirePaddle } from "@/server/api";
import { setMaxBid } from "@/server/engine";

import { engineFailure, enforceLotActionLimit, refusalError, requireLot } from "../shared";

const body = z.object({ maxCents: z.number().int().positive().max(2_147_483_647) });

/**
 * "Max…": a guest max the engine bids up to by the minimum raise. Answers 200 { limit, lot, leading,
 * bids }, or the same errors as the bid route.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/lots/[number]/max">>(async (request, { params }) => {
  const { slug, number } = await params;
  const session = await requirePaddle(slug, request);
  const { maxCents } = await readJson(request, body);
  const lot = await requireLot(slug, number);
  await enforceLotActionLimit(session);

  const result = await setMaxBid(session.paddleId, lot.id, maxCents).catch((error: unknown) => {
    throw engineFailure(error);
  });
  if (!result.ok) throw refusalError(result.refusal);
  return jsonOk({ limit: result.limit, lot: result.lot, leading: result.leading, bids: result.bids.length });
});
