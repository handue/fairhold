import { describe, expect, it } from "vitest";

import { DEFAULT_RECORDINGS_DIR } from "@/server/glim/config";
import { FALLBACK_LINE } from "@/server/glim/copy";
import { createRecordedGlimModel, loadRecordings, RECORDED_MODEL, type Recording } from "@/server/glim/recorded";
import { parseToolCall } from "@/server/glim/tools";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";

const ask = (guestText: string, attempt = 0) => ({ messages: [], guestText, attempt });

describe("recorded Glim", () => {
  it("has valid fixtures whose tool calls all parse", () => {
    const recordings = loadRecordings(DEFAULT_RECORDINGS_DIR);
    expect(recordings.map((recording) => recording.name).sort()).toEqual([
      "budget-above-hold",
      "cabin-raise",
      "golden-plan",
    ]);
    for (const recording of recordings) {
      for (const response of recording.responses) {
        for (const block of response.content) {
          if (block.type === "tool_use") expect(parseToolCall(block.name, block.input).ok).toBe(true);
        }
      }
    }
  });

  it("matches the guest's text whatever its case, spacing or apostrophes", async () => {
    const model = createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });
    const typed = await model.respond(ask("  $500.  I really want the CHEF’S dinner. Spa only under $120. "));
    const exact = await model.respond(ask(GOLDEN_SENTENCE));
    expect(typed.content.map((block) => block.type)).toEqual(["tool_use"]);
    expect(typed.model).toBe(RECORDED_MODEL);
    // Each replay gets its own tool_use id, so a repeated fixture keeps the history valid.
    expect(typed.content[0]).not.toEqual(exact.content[0]);
  });

  it("replays the retry for the second attempt and streams text in pieces", async () => {
    const model = createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });
    const deltas: string[] = [];
    const retry = await model.respond(ask("$600. Get me the chef's dinner, and the spa if it stays under $120.", 1), {
      onText: (delta) => deltas.push(delta),
    });
    expect(retry.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("Your bidding power is $500, so I planned within it.");
  });

  it("answers anything unrecorded with the fallback line", async () => {
    const model = createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });
    const message = await model.respond(ask("What's the weather like?"));
    expect(message.content).toEqual([
      { type: "text", text: `I can only replay recorded answers right now. ${FALLBACK_LINE}`, citations: null },
    ]);
  });

  it("refuses two recordings for the same guest text", async () => {
    const recording: Recording = {
      name: "one",
      guestText: "Hello",
      responses: [{ content: [{ type: "text", text: "Hi." }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }],
    };
    const model = createRecordedGlimModel({ recordings: [recording, { ...recording, name: "two", guestText: " hello " }] });
    await expect(model.respond(ask("Hello"))).rejects.toThrow(/same guest text: two/);
  });
});
