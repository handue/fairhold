/**
 * The message route's answer: one JSON object per line, flushed as each is written. The turn goes on
 * when the browser leaves: the model call is paid for, and the reply is there on the next open.
 */
import { logError } from "@/server/plans/db";
import { getPool } from "@/server/db/client";

import type { ChatStreamFrame } from "./types";

export const CHAT_STREAM_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  // no-transform keeps Next's compression from buffering; X-Accel-Buffering does the same for a proxy.
  "cache-control": "no-store, no-transform",
  "x-accel-buffering": "no",
  "x-content-type-options": "nosniff",
} as const;

const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

export function chatStreamResponse(run: (send: (frame: ChatStreamFrame) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: ChatStreamFrame) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          open = false;
        }
      };
      void run(send)
        .catch(async (error: unknown) => {
          console.error("[glim chat] turn failed:", error);
          await logError(getPool(), {
            code: "chat_turn_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          send({ type: "error", code: "internal_error", message: SOMETHING_WENT_WRONG });
        })
        .finally(() => {
          if (!open) return;
          open = false;
          controller.close();
        });
    },
    cancel() {
      open = false;
    },
  });
  return new Response(stream, { headers: CHAT_STREAM_HEADERS });
}
