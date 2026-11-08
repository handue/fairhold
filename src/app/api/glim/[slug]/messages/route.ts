import { z } from "zod";

import { enforceRateLimit, postRoute, readJson, requirePaddle } from "@/server/api";
import { acquireTurnLock, TURN_TIMEOUT_MS } from "@/server/chat/lock";
import { chatStreamResponse } from "@/server/chat/stream";
import { runChatTurn } from "@/server/chat/turn";
import { loadChatView } from "@/server/chat/view";
import { holdsNul } from "@/server/db/text";

const body = z.object({
  // Checked here because the stream's answer has started by the time the turn stores the text.
  text: z.string().refine((text) => !holdsNul(text)),
  /** The lot the guest opened Glim from ("Let Glim watch"), if any. */
  lotNumber: z.number().int().positive().max(9_999).nullish(),
});

/** A brake on scripts; the caps in runGlimTurn are what bound the model's cost. */
const MESSAGES_PER_MINUTE = { limit: 30, windowSeconds: 60 };

/**
 * One message to Glim. The paddle's turn lock is taken first, so a second message waits for the first
 * and reads what it left, and a wait that runs out answers 409 glim_busy. After that the answer is
 * NDJSON (ChatStreamFrame): the reply as it streams, then done with the panel's new view. Also 401
 * not_joined, 413 and 429.
 */
export const POST = postRoute<RouteContext<"/api/glim/[slug]/messages">>(async (request, { params }) => {
  const { slug } = await params;
  const session = await requirePaddle(slug, request);
  const { text, lotNumber } = await readJson(request, body);
  await enforceRateLimit(`glim_messages:${session.paddleId}`, MESSAGES_PER_MINUTE);

  const lock = await acquireTurnLock(session.paddleId);
  return chatStreamResponse(async (send) => {
    try {
      const turn = await runChatTurn({
        paddleId: session.paddleId,
        eventId: session.eventId,
        eventSlug: session.eventSlug,
        text,
        lotNumber: lotNumber ?? null,
        onEvent: send,
        signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
      });
      send({
        type: "done",
        view: await loadChatView(session),
        unsaved: turn.stored ? null : { guestText: turn.guestText, reply: turn.reply },
      });
    } finally {
      await lock.release();
    }
  });
});
