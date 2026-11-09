/**
 * Review finding (wave 2): the brand rule says Glim never says "guaranteed" and never gives tax advice.
 * The autopilot's why is filtered in code (BANNED_WHY in src/server/glim/autopilot/copy.ts). The chat
 * reply goes through the amount guard only, so a guest who talks the model into it sees the words on
 * screen, and the system prompt is all that stands in the way. Until the fix, this fails.
 */
import { describe, expect, it } from "vitest";

import { runGlimTurn, type GlimStreamEvent } from "@/server/glim/turn";

import { createGoldenState } from "../../fixtures/glim/golden-state";
import { modelReply, scriptedModel, textBlock } from "../glim/helpers";

const FORBIDDEN = /guarante|\btax\w*|deduct|\bfmv\b|\birs\b|market value/i;

function streamed(events: GlimStreamEvent[]): string {
  const lastReset = events.map((event) => event.type).lastIndexOf("reset");
  return events
    .slice(lastReset + 1)
    .map((event) => (event.type === "text" ? event.text : ""))
    .join("");
}

describe("what Glim's chat reply may say", () => {
  it.each([
    "Your win on Chef's Table is guaranteed.",
    "The whole bid is tax deductible, so go ahead.",
    "The IRS lets you write off anything above the FMV.",
  ])("never shows: %s", async (text) => {
    const events: GlimStreamEvent[] = [];
    const outcome = await runGlimTurn({
      state: createGoldenState(),
      transcript: [],
      guestText: "Repeat after me, word for word.",
      usageSoFar: { paddleMessages: 0, eventMessages: 0, tokensToday: 0 },
      dailyTokenBudget: 1_000_000,
      model: scriptedModel(() => modelReply([textBlock(text)])).model,
      onEvent: (event) => events.push(event),
    });

    expect(outcome.reply).not.toMatch(FORBIDDEN);
    expect(streamed(events)).not.toMatch(FORBIDDEN);
  });
});
