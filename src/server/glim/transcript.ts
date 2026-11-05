/**
 * The conversation exactly as it is sent to the API, kept append-only: a stored message is never
 * edited, reordered or removed. Opus 5.5 binds each thinking block to everything before it, so an
 * edited history is a 400 on newer accounts, and an untouched prefix is also what keeps the
 * prompt cache warm.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type TranscriptMessage = Anthropic.Beta.BetaMessageParam;
export type GlimTranscript = readonly TranscriptMessage[];

type ContentBlock = Anthropic.Beta.BetaContentBlock;

export function guestMessage(text: string): Anthropic.Beta.BetaUserMessageParam {
  return { role: "user", content: text };
}

/** Mid-conversation system messages must follow a user turn and precede an assistant turn. */
export function snapshotMessage(text: string): Anthropic.Beta.BetaSystemMessageParam {
  return { role: "system", content: text };
}

export interface ToolResult {
  toolUseId: string;
  text: string;
  isError: boolean;
}

/** Every tool_use in an assistant turn is answered in the one user message that follows it. */
export function toolResultMessage(results: readonly ToolResult[]): Anthropic.Beta.BetaUserMessageParam {
  return {
    role: "user",
    content: results.map((result) => ({
      type: "tool_result",
      tool_use_id: result.toolUseId,
      content: result.text,
      ...(result.isError ? { is_error: true } : {}),
    })),
  };
}

/**
 * The assistant turn as it must be echoed back. Blocks are kept as received, with one documented
 * exception: after a server-side fallback that happened mid-output, the thinking and tool_use
 * blocks the declining model wrote before the last fallback block are left out (the fallback
 * block itself and all text stay).
 */
export function replayableAssistantContent(content: readonly ContentBlock[]): ContentBlock[] {
  const boundary = content.findLastIndex((block) => block.type === "fallback");
  if (boundary < 0) return [...content];
  return content.filter((block, index) => {
    if (index >= boundary) return true;
    return block.type !== "thinking" && block.type !== "redacted_thinking" && block.type !== "tool_use";
  });
}
