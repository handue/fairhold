/**
 * GLIM_MODE=recorded: replays model responses stored in tests/fixtures/glim/recorded instead of
 * calling the API, so keyless local mode, CI and the demo without a key behave like live Glim.
 * A fixture is matched on the guest's text; its responses are the first attempt and, when the
 * first proposal was meant to be rejected, the retry.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { APIUserAbortError } from "@anthropic-ai/sdk";
import { z } from "zod";

import type { GlimMessage, GlimModel } from "./client";
import { GLIM_MODEL } from "./config";
import { FALLBACK_LINE } from "./copy";

const recordedBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), name: z.string(), input: z.record(z.string(), z.unknown()) }),
]);

const recordedResponseSchema = z.object({
  content: z.array(recordedBlockSchema),
  stop_reason: z.enum(["end_turn", "tool_use", "refusal", "max_tokens"]),
  usage: z
    .object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() })
    .default({ input_tokens: 0, output_tokens: 0 }),
});

export const recordingSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  guestText: z.string().min(1),
  responses: z.array(recordedResponseSchema).min(1),
});

export type Recording = z.infer<typeof recordingSchema>;
export type RecordedResponse = Recording["responses"][number];

/** Case, spacing and curly quotes don't change which fixture a message replays. */
export function normalizeGuestText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function loadRecordings(dir: string): Recording[] {
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const parsed = recordingSchema.safeParse(JSON.parse(readFileSync(path.join(dir, file), "utf8")));
    if (!parsed.success) {
      throw new Error(`Invalid Glim recording ${file}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    }
    return parsed.data;
  });
}

/** Stored as chat_messages.model for replayed replies, so nothing claims a live model served them. */
export const RECORDED_MODEL = "recorded";

/** Builds a complete Messages API response, as the live model would return it. */
export function syntheticMessage(
  content: GlimMessage["content"],
  stopReason: GlimMessage["stop_reason"],
  options: { usage?: { input_tokens: number; output_tokens: number }; model?: string } = {},
): GlimMessage {
  const usage = options.usage ?? { input_tokens: 0, output_tokens: 0 };
  return {
    id: `msg_${randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: options.model ?? GLIM_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

// Recordings hold no thinking blocks: a replayed transcript must stay valid if the paddle's
// conversation later continues in live mode, and a recorded signature would not be.
function toMessage(response: RecordedResponse): GlimMessage {
  const content: GlimMessage["content"] = response.content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text, citations: null };
    return {
      type: "tool_use",
      // A fresh id each time, since a fixture can replay more than once in one conversation.
      id: `toolu_recorded_${randomUUID().replaceAll("-", "")}`,
      name: block.name,
      input: block.input,
    };
  });
  return syntheticMessage(content, response.stop_reason, { usage: response.usage, model: RECORDED_MODEL });
}

const NO_MATCH: RecordedResponse = {
  content: [{ type: "text", text: `I can only replay recorded answers right now. ${FALLBACK_LINE}` }],
  stop_reason: "end_turn",
  usage: { input_tokens: 0, output_tokens: 0 },
};

/** Sends replayed text in small pieces so the panel streams as it does live. */
function streamText(text: string, onText: (delta: string) => void): void {
  for (const piece of text.match(/\S+\s*|\s+/g) ?? []) onText(piece);
}

export function createRecordedGlimModel(source: { dir: string } | { recordings: readonly Recording[] }): GlimModel {
  let byText: Map<string, Recording> | undefined;
  const index = () => {
    if (byText) return byText;
    const recordings = "dir" in source ? loadRecordings(source.dir) : source.recordings;
    byText = new Map();
    for (const recording of recordings) {
      const key = normalizeGuestText(recording.guestText);
      if (byText.has(key)) throw new Error(`Two Glim recordings match the same guest text: ${recording.name}`);
      byText.set(key, recording);
    }
    return byText;
  };

  return {
    mode: "recorded",
    async respond(request, hooks = {}) {
      if (hooks.signal?.aborted) throw new APIUserAbortError();
      const recording = index().get(normalizeGuestText(request.guestText));
      const responses = recording?.responses ?? [NO_MATCH];
      const response = responses[Math.min(request.attempt, responses.length - 1)] ?? NO_MATCH;
      const message = toMessage(response);
      if (hooks.onText) {
        for (const block of message.content) {
          if (block.type === "text") streamText(block.text, hooks.onText);
        }
      }
      return message;
    },
  };
}
