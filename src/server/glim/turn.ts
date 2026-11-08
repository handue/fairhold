/**
 * One guest message to Glim, end to end: caps, the state snapshot, the model call, the validator
 * (one retry, then the clamp) and the amount guard. The caller persists the result (chat_messages,
 * glim_actions, the transcript) and shows the reply and card. Nothing here bids: only the guest's
 * Start bidding click, through the engine's confirmPlan, turns a card into limits and bids.
 */
import type Anthropic from "@anthropic-ai/sdk";

import { createReplyStreamGuard, guardReply, type ReplyStreamGuard } from "./amountGuard";
import {
  buildHoldCard,
  buildPlanCard,
  cardAmounts,
  describeCardForModel,
  describeNoCardForModel,
  type GlimCard,
} from "./cards";
import { checkGlimCaps, type CapReason, type GlimUsageSoFar } from "./caps";
import {
  addTokens,
  callGlimModel,
  NO_TOKENS,
  totalTokens,
  type GlimFailure,
  type GlimModel,
  type GlimTokenUsage,
} from "./client";
import {
  amountGuardLine,
  CAP_REACHED_LINE,
  EMPTY_MESSAGE_LINE,
  NO_HOLD_LINE,
  NOTHING_FITS_LINE,
  TOO_LONG_LINE,
} from "./copy";
import { biddingPowerFigures, buildStateSnapshot } from "./prompt";
import { parseToolCall } from "./tools";
import {
  guestMessage,
  replayableAssistantContent,
  snapshotMessage,
  toolResultMessage,
  type GlimTranscript,
  type TranscriptMessage,
} from "./transcript";
import type { GlimActionRecord, GlimState, PlanIntent, ValidationIssue } from "./types";
import {
  checkHoldSuggestion,
  checkPlan,
  clampHoldSuggestion,
  clampPlan,
  describeIssuesForModel,
  toGlimActionRecords,
} from "./validator";

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;

export const MAX_GUEST_MESSAGE_LENGTH = 1_000;

export type GlimStreamEvent =
  | { type: "text"; text: string }
  /** Discard the text streamed so far: a retry or a code-written replacement follows. */
  | { type: "reset" };

export interface GlimTurnInput {
  state: GlimState;
  /** Everything stored for this paddle so far, exactly as previously appended. */
  transcript: GlimTranscript;
  guestText: string;
  usageSoFar: GlimUsageSoFar;
  dailyTokenBudget: number;
  model: GlimModel;
  onEvent?: (event: GlimStreamEvent) => void;
  signal?: AbortSignal;
  /** Whether Glim's autopilot is on (GLIM_AUTOPILOT): plan cards then carry its "ON MY OWN" rules. */
  autopilot?: boolean;
}

/** The validated proposal behind a plan card, for glim_plans.proposal. */
export interface GlimProposalRecord {
  tool: string;
  /** The model's tool input, verbatim. */
  input: unknown;
  /** The intent the card was built from, after any repair. */
  intent: PlanIntent;
  adjusted: boolean;
  /**
   * The first budget the model parsed from the guest's words this turn, before a rejected
   * proposal was lowered on the retry, and even when the first call left it out and only the
   * retry carried it: the budget the guest named (the mandate's B). Null when they named none.
   */
  namedBudgetCents: number | null;
}

export type GlimTurnError = GlimFailure | CapReason | "empty_message" | "message_too_long";

export interface GlimTurnResult {
  reply: string;
  replySource: "model" | "template" | "fallback";
  /** True when the amount guard replaced the model's text. */
  replyReplaced: boolean;
  card: GlimCard | null;
  proposal: GlimProposalRecord | null;
  /** glim_actions rows for every rejected proposal or part of one. */
  rejections: GlimActionRecord[];
  /** Append these to the stored transcript, in order. Empty when the turn is not kept. */
  transcriptAppend: TranscriptMessage[];
  /** The model that served the reply (a fallback model after a refusal), if one was called. */
  model: string | null;
  usage: GlimTokenUsage;
  tokensUsed: number;
  latencyMs: number;
  attempts: number;
  error: GlimTurnError | null;
}

type Evaluation =
  | { kind: "rejected"; issues: ValidationIssue[] }
  | { kind: "shown"; card: GlimCard; proposal: GlimProposalRecord | null; adjustments: ValidationIssue[] }
  | { kind: "nothing"; adjustments: ValidationIssue[] };

function invalidInput(message: string): ValidationIssue {
  return { reason: "invalid_tool_input", lotNumber: null, lotId: null, amountCents: null, limitCents: null, message };
}

interface CardContext {
  /** The first plan budget parsed this turn, null until one is (see GlimProposalRecord.namedBudgetCents). */
  namedBudgetCents: number | null;
  autopilot: boolean;
}

/** The first attempt only checks; the retry is repaired by the clamp if it still breaks a rule. */
function evaluateToolCall(block: ToolUseBlock, state: GlimState, final: boolean, context: CardContext): Evaluation {
  const parsed = parseToolCall(block.name, block.input);
  if (!parsed.ok) {
    const issues = [invalidInput(parsed.message)];
    return final ? { kind: "nothing", adjustments: issues } : { kind: "rejected", issues };
  }

  if (parsed.call.kind === "plan") {
    const { intent } = parsed.call;
    const { namedBudgetCents, autopilot } = context;
    const check = checkPlan(intent, state);
    if (check.issues.length === 0 && check.allocation) {
      return {
        kind: "shown",
        card: buildPlanCard({ tool: intent.tool, allocation: check.allocation, state, adjustments: [], intent, namedBudgetCents, autopilot }),
        proposal: { tool: block.name, input: block.input, intent, adjusted: false, namedBudgetCents },
        adjustments: [],
      };
    }
    if (!final) return { kind: "rejected", issues: check.issues };
    const clamped = clampPlan(intent, state);
    if (!clamped.allocation) return { kind: "nothing", adjustments: clamped.adjustments };
    return {
      kind: "shown",
      card: buildPlanCard({
        tool: intent.tool,
        allocation: clamped.allocation,
        state,
        adjustments: clamped.adjustments,
        intent: clamped.intent,
        namedBudgetCents,
        autopilot,
      }),
      proposal: { tool: block.name, input: block.input, intent: clamped.intent, adjusted: true, namedBudgetCents },
      adjustments: clamped.adjustments,
    };
  }

  const { intent } = parsed.call;
  const issues = checkHoldSuggestion(intent, state);
  if (issues.length === 0) {
    const card = buildHoldCard({ amountCents: intent.amountCents, state, lotNumbers: intent.lotNumbers, adjustments: [] });
    return { kind: "shown", card, proposal: null, adjustments: [] };
  }
  if (!final) return { kind: "rejected", issues };
  const clamped = clampHoldSuggestion(intent, state);
  if (clamped.amountCents === null) return { kind: "nothing", adjustments: clamped.adjustments };
  const card = buildHoldCard({
    amountCents: clamped.amountCents,
    state,
    lotNumbers: intent.lotNumbers,
    adjustments: clamped.adjustments,
  });
  return { kind: "shown", card, proposal: null, adjustments: clamped.adjustments };
}

function replyText(content: readonly ContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/** Sends whatever the stream guard held back, or replaces the draft when the reply changed. */
function finishStream(guard: ReplyStreamGuard, reply: string, emit: (event: GlimStreamEvent) => void): void {
  const shown = guard.text.slice(0, guard.emittedLength).trimStart();
  if (reply.startsWith(shown)) {
    const rest = reply.slice(shown.length);
    if (rest) emit({ type: "text", text: rest });
    return;
  }
  emit({ type: "reset" });
  if (reply) emit({ type: "text", text: reply });
}

export async function runGlimTurn(input: GlimTurnInput): Promise<GlimTurnResult> {
  const started = performance.now();
  const { state } = input;
  const emit = input.onEvent ?? (() => {});
  const records = (issues: readonly ValidationIssue[]) =>
    toGlimActionRecords(issues, { paddleId: state.guest.paddleId, holdCents: state.holdCents });

  let usage = NO_TOKENS;
  let attempts = 0;
  let servedBy: string | null = null;
  const rejections: GlimActionRecord[] = [];
  const result = (
    fields: Pick<GlimTurnResult, "reply" | "replySource" | "error"> & Partial<GlimTurnResult>,
  ): GlimTurnResult => ({
    replyReplaced: false,
    card: null,
    proposal: null,
    rejections,
    transcriptAppend: [],
    model: servedBy,
    usage,
    tokensUsed: totalTokens(usage),
    attempts,
    latencyMs: Math.round(performance.now() - started),
    ...fields,
  });

  // Answers that need no model call; like every path, the streamed text ends equal to the reply.
  const answerWithoutModel = (reply: string, error: GlimTurnError) => {
    emit({ type: "text", text: reply });
    return result({ reply, replySource: "template", error });
  };
  const guestText = input.guestText.trim();
  if (!guestText) return answerWithoutModel(EMPTY_MESSAGE_LINE, "empty_message");
  if (guestText.length > MAX_GUEST_MESSAGE_LENGTH) return answerWithoutModel(TOO_LONG_LINE, "message_too_long");
  const caps = checkGlimCaps(input.usageSoFar, input.dailyTokenBudget);
  if (!caps.ok) return answerWithoutModel(CAP_REACHED_LINE, caps.reason);

  const snapshot = buildStateSnapshot(state);
  // The first budget a plan proposal parsed this turn: the budget the guest named. A retry may
  // lower it to fit the hold, or a first call may leave it out; neither changes the guest's words.
  let namedBudgetCents: number | null = null;
  // The guest's turn, then the snapshot as a system message right after it, as the API requires.
  const pending: TranscriptMessage[] = [guestMessage(guestText), snapshotMessage(snapshot.text)];
  const guardTemplate = amountGuardLine(state.holdCents, biddingPowerFigures(state)?.leftCents ?? null);

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts = attempt + 1;
    const guard = createReplyStreamGuard(snapshot.amounts, (text) => emit({ type: "text", text }));
    const call = await callGlimModel(
      input.model,
      { messages: [...input.transcript, ...pending], guestText, attempt },
      { onText: (delta) => guard.push(delta), signal: input.signal },
    );
    usage = addTokens(usage, call.usage);
    if (!call.ok) {
      // A failed turn is not kept: the next request continues from the last complete turn.
      if (guard.emittedLength > 0) emit({ type: "reset" });
      emit({ type: "text", text: call.reply });
      return result({ reply: call.reply, replySource: "fallback", error: call.failure });
    }

    servedBy = call.message.model;
    const content = replayableAssistantContent(call.message.content);
    pending.push({ role: "assistant", content });
    const text = replyText(content);
    const [toolUse, ...extraToolUses] = content.filter((block): block is ToolUseBlock => block.type === "tool_use");

    if (!toolUse) {
      const guarded = guardReply(text, snapshot.amounts, guardTemplate);
      finishStream(guard, guarded.text, emit);
      return result({
        reply: guarded.text,
        replySource: guarded.replaced ? "template" : "model",
        replyReplaced: guarded.replaced,
        transcriptAppend: pending,
        error: null,
      });
    }

    const parsedCall = parseToolCall(toolUse.name, toolUse.input);
    if (namedBudgetCents === null && parsedCall.ok && parsedCall.call.kind === "plan") {
      namedBudgetCents = parsedCall.call.intent.budgetCents;
    }
    const evaluation = evaluateToolCall(toolUse, state, attempt === 1, {
      namedBudgetCents,
      autopilot: input.autopilot ?? true,
    });
    // Parallel tool use is disabled, so any extra call is only answered, never shown.
    const answer = (body: string, isError: boolean) =>
      toolResultMessage([
        { toolUseId: toolUse.id, text: body, isError },
        ...extraToolUses.map((block) => ({
          toolUseId: block.id,
          text: "Only one proposal is shown per reply; this one was not.",
          isError: true,
        })),
      ]);

    if (evaluation.kind === "rejected") {
      rejections.push(...records(evaluation.issues));
      pending.push(answer(describeIssuesForModel(evaluation.issues), true));
      if (guard.emittedLength > 0) emit({ type: "reset" });
      continue;
    }

    rejections.push(...records(evaluation.adjustments));
    if (evaluation.kind === "nothing") {
      pending.push(answer(describeNoCardForModel(evaluation.adjustments), true));
      const reply = state.holdCents === null ? NO_HOLD_LINE : NOTHING_FITS_LINE;
      finishStream(guard, reply, emit);
      return result({ reply, replySource: "template", transcriptAppend: pending, error: null });
    }

    pending.push(answer(describeCardForModel(evaluation.card, state, evaluation.adjustments), false));
    // The card carries every amount, so a reply the guard rejects is simply left out.
    const allowed = new Set([...snapshot.amounts, ...cardAmounts(evaluation.card)]);
    const guarded = guardReply(text, allowed, "");
    finishStream(guard, guarded.text, emit);
    return result({
      reply: guarded.text,
      replySource: guarded.replaced ? "template" : "model",
      replyReplaced: guarded.replaced,
      card: evaluation.card,
      proposal: evaluation.proposal,
      transcriptAppend: pending,
      error: null,
    });
  }

  // Unreachable: the second attempt never asks for a third.
  throw new Error("Glim turn ended without a result");
}
