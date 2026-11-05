import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { replayableAssistantContent, toolResultMessage } from "@/server/glim/transcript";

type Block = Anthropic.Beta.BetaContentBlock;

const thinking = (signature: string): Block => ({ type: "thinking", thinking: "", signature });
const text = (value: string): Block => ({ type: "text", text: value, citations: null });
const toolUse = (id: string): Block => ({ type: "tool_use", id, name: "propose_plan", input: {} });
const fallback: Block = {
  type: "fallback",
  from: { model: "claude-opus-5-5" },
  to: { model: "claude-opus-5" },
  trigger: { type: "refusal", category: null },
};

describe("replayableAssistantContent", () => {
  it("keeps an ordinary turn exactly as received", () => {
    const content = [thinking("sig-1"), text("Here's my plan."), toolUse("toolu_1")];
    const replayed = replayableAssistantContent(content);
    expect(replayed).toEqual(content);
    expect(replayed[0]).toBe(content[0]);
  });

  it("after a mid-output fallback, drops the declining model's thinking and tool calls before the boundary", () => {
    const content = [thinking("sig-1"), text("Here is"), toolUse("toolu_cut"), fallback, thinking("sig-2"), text(" my plan."), toolUse("toolu_2")];
    expect(replayableAssistantContent(content)).toEqual([
      text("Here is"),
      fallback,
      thinking("sig-2"),
      text(" my plan."),
      toolUse("toolu_2"),
    ]);
  });
});

describe("toolResultMessage", () => {
  it("answers every tool call of a turn in one user message, flagging rejected ones", () => {
    expect(
      toolResultMessage([
        { toolUseId: "toolu_1", text: "Shown.", isError: false },
        { toolUseId: "toolu_2", text: "Rejected.", isError: true },
      ]),
    ).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "Shown." },
        { type: "tool_result", tool_use_id: "toolu_2", content: "Rejected.", is_error: true },
      ],
    });
  });
});
