/**
 * Glim's model call: one streamed claude-opus-5-5 request per attempt, built from a fixed system
 * prompt and tool list plus the append-only transcript. GLIM_MODE=recorded swaps in recorded.ts,
 * which replays fixtures with the same interface. Refusals and API errors come back as results
 * carrying the approved fallback line instead of throwing.
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { BetaMessageStreamParams } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import {
  getGlimConfig,
  GLIM_EFFORT,
  GLIM_MAX_TOKENS,
  GLIM_MODEL,
  SERVER_SIDE_FALLBACK_BETA,
  type GlimConfig,
  type GlimMode,
} from "./config";
import { AUTOPILOT_SYSTEM_PROMPT } from "./autopilot/prompt";
import { DECISION_SCHEMA } from "./autopilot/schema";
import { ERROR_LINE } from "./copy";
import { GLIM_SYSTEM_PROMPT } from "./prompt";
import { createRecordedGlimModel } from "./recorded";
import { GLIM_TOOL_CHOICE, GLIM_TOOLS } from "./tools";
import type { GlimTranscript } from "./transcript";

export type GlimMessage = Anthropic.Beta.BetaMessage;

/** chat: a guest's message to Glim (tools, transcript). autopilot: one stateless decision. */
export type GlimRequestProfile = "chat" | "autopilot";

export interface GlimModelRequest {
  messages: GlimTranscript;
  /** This turn's guest text; recorded mode picks its fixture by it. */
  guestText: string;
  /** 0 for a guest message's first call, 1 for the single retry after a rejected proposal. */
  attempt: number;
  /** Which request to build; chat when omitted. */
  profile?: GlimRequestProfile;
  /** Recorded mode matches this before the guest text (autopilot decisions). */
  fixtureKey?: string;
}

export interface GlimModelHooks {
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export interface GlimModel {
  readonly mode: GlimMode;
  /** Resolves with the final message; API failures reject with the SDK's typed errors. */
  respond(request: GlimModelRequest, hooks?: GlimModelHooks): Promise<GlimMessage>;
}

/** The request for every Glim call. Only `messages` varies, so the cached prefix never changes. */
export function buildGlimRequest(messages: GlimTranscript): BetaMessageStreamParams {
  return {
    model: GLIM_MODEL,
    max_tokens: GLIM_MAX_TOKENS,
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: GLIM_EFFORT },
    // Tools plus this block are one prefix shared by every guest. The top-level marker also
    // caches each conversation up to its newest message.
    system: [{ type: "text", text: GLIM_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    tools: GLIM_TOOLS,
    tool_choice: GLIM_TOOL_CHOICE,
    messages: [...messages],
  };
}

/** Thinking counts toward max_tokens; a decision is one small JSON object after low-effort thinking. */
export const AUTOPILOT_MAX_TOKENS = 4_096;

/**
 * The autopilot's request (docs/planning/glim-autopilot.md §4.3): no tools, and structured
 * output, so the reply is exactly one schema-valid decision. The system prompt is its own cached
 * prefix; each review is new, so there is no top-level cache marker to write and never read.
 */
export function buildAutopilotRequest(messages: GlimTranscript): BetaMessageStreamParams {
  return {
    model: GLIM_MODEL,
    max_tokens: AUTOPILOT_MAX_TOKENS,
    betas: [SERVER_SIDE_FALLBACK_BETA],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: { effort: GLIM_EFFORT, format: { type: "json_schema", schema: DECISION_SCHEMA } },
    system: [{ type: "text", text: AUTOPILOT_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [...messages],
  };
}

/** The slice of the SDK client Glim uses, so tests can stand in for it. */
export interface StreamingMessagesClient {
  beta: {
    messages: {
      stream(
        body: BetaMessageStreamParams,
        options?: { signal?: AbortSignal },
      ): {
        on(event: "text", listener: (delta: string) => void): unknown;
        finalMessage(): Promise<GlimMessage>;
      };
    };
  };
}

export function createLiveGlimModel(options: { apiKey: string } | { client: StreamingMessagesClient }): GlimModel {
  const client: StreamingMessagesClient =
    "client" in options
      ? options.client
      : // One SDK retry for 429/5xx and dropped connections; a guest is waiting on the reply.
        new Anthropic({ apiKey: options.apiKey, maxRetries: 1, timeout: 45_000 });
  return {
    mode: "live",
    async respond(request, hooks = {}) {
      const body =
        request.profile === "autopilot" ? buildAutopilotRequest(request.messages) : buildGlimRequest(request.messages);
      const stream = client.beta.messages.stream(body, { signal: hooks.signal });
      if (hooks.onText) stream.on("text", hooks.onText);
      return stream.finalMessage();
    },
  };
}

export function createGlimModel(config: GlimConfig): GlimModel {
  if (config.mode === "live" && config.apiKey) return createLiveGlimModel({ apiKey: config.apiKey });
  return createRecordedGlimModel({ dir: config.recordingsDir });
}

let processModel: GlimModel | undefined;

/** The process-wide model for the configured GLIM_MODE (recorded until a key is set). */
export function getGlimModel(): GlimModel {
  processModel ??= createGlimModel(getGlimConfig());
  return processModel;
}

export interface GlimTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_TOKENS: GlimTokenUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

export function addTokens(a: GlimTokenUsage, b: GlimTokenUsage): GlimTokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** What the daily budget counts: every token the call processed, cached or not. */
export function totalTokens(usage: GlimTokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** Sums every attempt the API billed, including one a server-side fallback replaced. */
function tokenUsage(message: GlimMessage): GlimTokenUsage {
  const entries = message.usage.iterations?.length ? message.usage.iterations : [message.usage];
  return entries.reduce<GlimTokenUsage>(
    (sum, entry) =>
      addTokens(sum, {
        inputTokens: entry.input_tokens,
        outputTokens: entry.output_tokens,
        cacheReadTokens: entry.cache_read_input_tokens ?? 0,
        cacheWriteTokens: entry.cache_creation_input_tokens ?? 0,
      }),
    NO_TOKENS,
  );
}

export type GlimFailure =
  | "refusal"
  | "truncated"
  | "unexpected_stop"
  | "aborted"
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "api_error"
  | "unexpected_error";

export type GlimCallResult =
  | { ok: true; message: GlimMessage; usage: GlimTokenUsage; latencyMs: number }
  | {
      ok: false;
      failure: GlimFailure;
      /** Always design/22's error line, which ends in the approved fallback. */
      reply: string;
      /** For error_log: an error class, status and request id, or a refusal category. */
      detail: string | null;
      usage: GlimTokenUsage;
      latencyMs: number;
    };

function classifyError(error: unknown): GlimFailure {
  // Subclasses first: every one of these extends APIError.
  if (error instanceof APIUserAbortError) return "aborted";
  if (error instanceof APIConnectionTimeoutError) return "timeout";
  if (error instanceof APIConnectionError) return "network_error";
  if (error instanceof RateLimitError) return "rate_limited";
  if (error instanceof APIError) return "api_error";
  return "unexpected_error";
}

function describeError(error: unknown): string {
  if (error instanceof APIError) {
    return [error.constructor.name, error.status, error.requestID].filter((part) => part != null).join(" ");
  }
  return error instanceof Error ? error.name : "unknown error";
}

/**
 * One model call, classified. A refusal is never retried here: server-side fallbacks have
 * already tried the fallback model, and a partial reply from a refused stream is discarded.
 */
export async function callGlimModel(
  model: GlimModel,
  request: GlimModelRequest,
  hooks: GlimModelHooks = {},
): Promise<GlimCallResult> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  const fail = (failure: GlimFailure, detail: string | null, usage: GlimTokenUsage = NO_TOKENS): GlimCallResult => ({
    ok: false,
    failure,
    reply: ERROR_LINE,
    detail,
    usage,
    latencyMs: latency(),
  });

  let message: GlimMessage;
  try {
    message = await model.respond(request, hooks);
  } catch (error) {
    return fail(classifyError(error), describeError(error));
  }

  const usage = tokenUsage(message);
  switch (message.stop_reason) {
    case "end_turn":
    case "tool_use":
      return { ok: true, message, usage, latencyMs: latency() };
    case "refusal":
      return fail("refusal", message.stop_details?.category ?? null, usage);
    case "max_tokens":
      // A tool input cut off here can still parse, so the whole turn is dropped.
      return fail("truncated", null, usage);
    default:
      return fail("unexpected_stop", String(message.stop_reason), usage);
  }
}
