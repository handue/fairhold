import type Anthropic from "@anthropic-ai/sdk";

import type { GlimMessage, GlimModel, GlimModelRequest } from "@/server/glim/client";
import { syntheticMessage } from "@/server/glim/recorded";

type Block = Anthropic.Beta.BetaContentBlock;

let nextToolUseId = 1;

export const textBlock = (text: string): Block => ({ type: "text", text, citations: null });

export const toolUseBlock = (name: string, input: unknown): Block => ({
  type: "tool_use",
  id: `toolu_test_${nextToolUseId++}`,
  name,
  input,
});

export function modelReply(content: Block[], stopReason?: GlimMessage["stop_reason"]): GlimMessage {
  return syntheticMessage(content, stopReason ?? (content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn"));
}

export const goldenProposal = (budgetDollars = 500, spaCapDollars = 120) => ({
  budget_dollars: budgetDollars,
  items: [
    { lot_number: 7, priority: 1, cap_dollars: null },
    { lot_number: 12, priority: 2, cap_dollars: spaCapDollars },
  ],
});

/** A stand-in model that answers from a script and records every request it was sent. */
export function scriptedModel(script: (request: GlimModelRequest) => GlimMessage | Promise<GlimMessage>) {
  const requests: GlimModelRequest[] = [];
  const model: GlimModel = {
    mode: "live",
    async respond(request, hooks = {}) {
      requests.push(structuredClone(request));
      const message = await script(request);
      for (const block of message.content) if (block.type === "text") hooks.onText?.(block.text);
      return message;
    },
  };
  return { model, requests };
}
