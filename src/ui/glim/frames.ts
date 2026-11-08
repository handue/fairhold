/**
 * The browser's end of POST /api/glim/[slug]/messages: one JSON frame per line (ChatStreamFrame),
 * delivered as soon as its line is complete.
 */
import type { ChatStreamFrame } from "@/server/chat/types";

import { ApiClientError } from "../api";

const NETWORK_MESSAGE = "We couldn’t reach Fairhold. Check your connection and try again.";
const UNREADABLE_MESSAGE = "Something went wrong. Please try again.";

/** Calls `onFrame` for each complete line of the stream, in order. */
export async function readChatFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: ChatStreamFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onFrame(JSON.parse(line) as ChatStreamFrame);
    }
  }
  if (buffer.trim()) onFrame(JSON.parse(buffer) as ChatStreamFrame);
}

/**
 * Sends one message and reads the streamed answer. A refusal before the stream starts (not joined,
 * busy, too many) throws ApiClientError, like every other call in src/ui/api.ts.
 */
export async function postChatMessage(
  path: string,
  body: { text: string; lotNumber: number | null },
  onFrame: (frame: ChatStreamFrame) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/x-ndjson" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_MESSAGE);
  }
  if (!response.ok || !response.body) {
    const answer = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const error = answer?.error;
    throw new ApiClientError(response.status, error?.code ?? "invalid_response", error?.message ?? UNREADABLE_MESSAGE, error?.details ?? null);
  }
  try {
    await readChatFrames(response.body, onFrame);
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_MESSAGE);
  }
}
