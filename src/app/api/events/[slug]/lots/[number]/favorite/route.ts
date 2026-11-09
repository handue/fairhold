import { z } from "zod";

import { jsonOk, postRoute, readJson, requirePaddle } from "@/server/api";
import { setFavorite } from "@/server/queries/favorites";

import { enforceLotActionLimit, requireLot } from "../shared";

const body = z.object({ favorite: z.boolean() });

/**
 * The heart: { favorite: true } or { favorite: false }, a value rather than a flip, so a double tap
 * or a retry lands where the guest meant. Answers 200 { favorite }; 401 not_joined; 404 lot_not_found.
 */
export const POST = postRoute<RouteContext<"/api/events/[slug]/lots/[number]/favorite">>(async (request, { params }) => {
  const { slug, number } = await params;
  const session = await requirePaddle(slug, request);
  const { favorite } = await readJson(request, body);
  const lot = await requireLot(slug, number);
  await enforceLotActionLimit(session);

  await setFavorite({
    eventId: lot.eventId,
    paddleId: session.paddleId,
    lotId: lot.id,
    lotNumber: lot.number,
    isFavorite: favorite,
  });
  return jsonOk({ favorite });
});
