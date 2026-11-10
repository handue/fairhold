import Anthropic, {
  APIConnectionTimeoutError,
  APIUserAbortError,
  InternalServerError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import {
  buildGlimRequest,
  callGlimModel,
  createLiveGlimModel,
  type GlimMessage,
  type StreamingMessagesClient,
} from "@/server/glim/client";
import { ERROR_LINE, FALLBACK_LINE } from "@/server/glim/copy";
import { GLIM_SYSTEM_PROMPT } from "@/server/glim/prompt";
import { GLIM_TOOLS } from "@/server/glim/tools";
import { guestMessage, snapshotMessage } from "@/server/glim/transcript";

import { modelReply, scriptedModel, textBlock } from "./helpers";

const MESSAGES = [guestMessage("Hello"), snapshotMessage("STATE SNAPSHOT · test")];
const REQUEST = { messages: MESSAGES, guestText: "Hello", attempt: 0 };

describe("buildGlimRequest", () => {
  const request = buildGlimRequest(MESSAGES);

  it("calls claude-opus-5-5 with adaptive thinking at low effort", () => {
    expect(request.model).toBe("claude-opus-5-5");
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: "low" });
    expect(request.max_tokens).toBeGreaterThanOrEqual(4_096);
  });

  it("opts into server-side fallbacks with the header the scalar form needs", () => {
    expect(request.fallbacks).toBe("default");
    expect(request.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("sends no sampling parameters, which Opus 5.5 rejects", () => {
    for (const key of ["temperature", "top_p", "top_k"]) expect(request).not.toHaveProperty(key);
  });

  it("uses strict tools with tool_choice auto and a cached system prompt", () => {
    expect(request.tools).toBe(GLIM_TOOLS);
    expect(request.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
    expect(request.system).toEqual([{ type: "text", text: GLIM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  });

  it("sends the transcript as given", () => {
    expect(request.messages).toEqual(MESSAGES);
  });
});

describe("createLiveGlimModel", () => {
  it("streams one request through the SDK and passes text deltas on", async () => {
    const sent: { body: unknown; signal: AbortSignal | undefined }[] = [];
    const final = modelReply([textBlock("Hi Jamie.")]);
    const client: StreamingMessagesClient = {
      beta: {
        messages: {
          stream(body, options) {
            sent.push({ body, signal: options?.signal });
            const listeners: ((delta: string) => void)[] = [];
            return {
              on(_event, listener) {
                listeners.push(listener);
                return this;
              },
              async finalMessage() {
                for (const listener of listeners) listener("Hi Jamie.");
                return final;
              },
            };
          },
        },
      },
    };
    const deltas: string[] = [];
    const controller = new AbortController();
    const message = await createLiveGlimModel({ client }).respond(REQUEST, {
      onText: (delta) => deltas.push(delta),
      signal: controller.signal,
    });

    expect(message).toBe(final);
    expect(deltas).toEqual(["Hi Jamie."]);
    expect(sent).toEqual([{ body: buildGlimRequest(MESSAGES), signal: controller.signal }]);
  });
});

describe("the live model through the real SDK (offline)", () => {
  const sse = (events: object[]) =>
    events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join("");

  it("sends the beta header, fallbacks, strict tools and a streamed body", async () => {
    const captured: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const client = new Anthropic({
      apiKey: "test-key-not-real",
      maxRetries: 0,
      fetch: async (input, init) => {
        captured.push({
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        const body = sse([
          {
            type: "message_start",
            message: {
              id: "msg_offline",
              type: "message",
              role: "assistant",
              model: "claude-opus-5-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 12, output_tokens: 1 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi Jamie." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } },
          { type: "message_stop" },
        ]);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });

    const deltas: string[] = [];
    const message = await createLiveGlimModel({ client }).respond(REQUEST, { onText: (delta) => deltas.push(delta) });

    // What is stored and replayed is the JSON form, without the SDK's non-enumerable helpers.
    expect(JSON.parse(JSON.stringify(message.content))).toEqual([{ type: "text", text: "Hi Jamie.", citations: null }]);
    expect(message.stop_reason).toBe("end_turn");
    expect(deltas).toEqual(["Hi Jamie."]);

    const [request] = captured;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("anthropic-beta")).toBe("server-side-fallback-2026-07-01");
    expect(request?.body).toMatchObject({
      model: "claude-opus-5-5",
      stream: true,
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
    expect(request?.body).not.toHaveProperty("betas");
    expect((request?.body.tools as { strict: boolean }[]).every((tool) => tool.strict)).toBe(true);
    expect((request?.body.messages as { role: string }[]).map((entry) => entry.role)).toEqual(["user", "system"]);
  });
});

describe("callGlimModel", () => {
  const failingWith = (error: Error) => scriptedModel(() => Promise.reject(error)).model;

  it("returns the message and its token usage on a normal reply", async () => {
    const message = modelReply([textBlock("Hi.")]);
    message.usage.input_tokens = 900;
    message.usage.output_tokens = 40;
    message.usage.cache_read_input_tokens = 2_000;
    const result = await callGlimModel(scriptedModel(() => message).model, REQUEST);
    expect(result).toMatchObject({
      ok: true,
      usage: { inputTokens: 900, outputTokens: 40, cacheReadTokens: 2_000, cacheWriteTokens: 0 },
    });
  });

  it("counts every attempt a server-side fallback billed", async () => {
    const message = modelReply([textBlock("Hi.")]);
    message.usage.iterations = [
      { type: "message", model: "claude-opus-5-5", input_tokens: 100, output_tokens: 5, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { type: "fallback_message", model: "claude-opus-5", input_tokens: 120, output_tokens: 30, cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ];
    const result = await callGlimModel(scriptedModel(() => message).model, REQUEST);
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 35, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("turns a refusal into the approved fallback line", async () => {
    const refused: GlimMessage = modelReply([], "refusal");
    refused.stop_details = {
      type: "refusal",
      category: "cyber",
      explanation: null,
      fallback_credit_token: null,
      fallback_has_prefill_claim: null,
      recommended_model: null,
    };
    const result = await callGlimModel(scriptedModel(() => refused).model, REQUEST);
    expect(result).toMatchObject({ ok: false, failure: "refusal", reply: ERROR_LINE, detail: "cyber" });
    // design/22 #4: the approved line, with its reason in front of it.
    expect(FALLBACK_LINE).toBe("You can still bid yourself.");
    expect(ERROR_LINE).toBe("I can’t answer right now. You can still bid yourself.");
  });

  it("drops a reply cut off at max_tokens", async () => {
    const result = await callGlimModel(scriptedModel(() => modelReply([], "max_tokens")).model, REQUEST);
    expect(result).toMatchObject({ ok: false, failure: "truncated", reply: ERROR_LINE });
  });

  it("classifies API errors without throwing", async () => {
    const headers = new Headers({ "request-id": "req_test" });
    const cases = [
      [new RateLimitError(429, undefined, "slow down", headers), "rate_limited", "RateLimitError 429 req_test"],
      [new InternalServerError(500, undefined, "boom", headers), "api_error", "InternalServerError 500 req_test"],
      [new APIConnectionTimeoutError(), "timeout", "APIConnectionTimeoutError"],
      [new APIUserAbortError(), "aborted", "APIUserAbortError"],
      [new TypeError("bad"), "unexpected_error", "TypeError"],
    ] as const;
    for (const [error, failure, detail] of cases) {
      const result = await callGlimModel(failingWith(error), REQUEST);
      expect(result).toMatchObject({ ok: false, failure, detail, reply: ERROR_LINE });
    }
  });
});
