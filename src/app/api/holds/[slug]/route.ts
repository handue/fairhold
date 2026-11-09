import { z } from "zod";

import { jsonOk, postRoute, publicOrigin, readJson, requirePaddle } from "@/server/api";
import { createHold } from "@/server/holds/create";

const body = z.object({
  amountCents: z.number().int().positive(),
  /** Where the guest goes after approving; createHold accepts only a page of this event. */
  next: z.string().max(2_048).nullish(),
});

/**
 * Opens a PayPal window for this browser's paddle. Answers 201 { holdId, amountCents, approvalUrl };
 * 401 not_joined; and the refusals createHold lists (src/server/holds/create.ts).
 */
export const POST = postRoute<RouteContext<"/api/holds/[slug]">>(async (request, { params }) => {
  const { slug } = await params;
  const session = await requirePaddle(slug, request);
  const { amountCents, next } = await readJson(request, body);
  const hold = await createHold({ paddleId: session.paddleId, amountCents, origin: publicOrigin(request), next });
  return jsonOk(hold, { status: 201 });
});
