/**
 * One autopilot decision, end to end and without the database (docs/planning/glim-autopilot.md
 * §4): code works out the options; with none, nothing happens. Otherwise Claude chooses between
 * them and keep, unless the caps, the gap between calls or a closing lot hand the choice to the
 * deterministic rule. Whatever is chosen passes checkDecision before the caller applies it; a
 * model failure or a decision that breaks a rule falls back to the rule. Nothing here bids.
 */
import { AUTOPILOT_CAPS, type AutopilotCapCheck } from "../caps";
import { callGlimModel, NO_TOKENS, totalTokens, type GlimModel, type GlimTokenUsage } from "../client";
import { GLIM_MODEL } from "../config";
import { RECORDED_MODEL } from "../recorded";
import type { GlimActionRecord, ValidationIssue } from "../types";
import { toGlimActionRecords } from "../validator";

import { filterWhy, mainMove } from "./copy";
import { computeOptions, type AutopilotOptions } from "./options";
import { AUTOPILOT_USER_TEXT, autopilotMessages, buildBrief, fixtureKeyFor } from "./prompt";
import { ruleDecision } from "./rule";
import { parseDecision } from "./schema";
import {
  primaryTrigger,
  type AutopilotContext,
  type AutopilotDecider,
  type AutopilotDecision,
  type AutopilotDecisionLot,
  type DecisionReason,
} from "./types";
import { checkDecision, type CheckedChange, type DecisionCheck, type RaiseBounds } from "./validate";

export interface DecideAutopilotInput {
  context: AutopilotContext;
  model: GlimModel;
  /** checkAutopilotModel for this run; when not ok, the rule decides. */
  modelAllowed: AutopilotCapCheck;
  /** Runs right before the model call (the "Deciding…" row, last_model_call_at). */
  onModelCall?: () => Promise<void> | void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PreparedRaise {
  amountCents: number;
  bounds: RaiseBounds;
  /** The lot the raise is for: the one that gains most at the higher hold. */
  lotId: string;
  lotNumber: number;
  /** The plan to apply once the new hold lands (§6.4 pendingIntent). */
  lots: AutopilotDecisionLot[];
  atCeiling: CheckedChange;
}

export type DecidedOutcome = "skipped" | "keep" | "change" | "prepare_raise";

export interface AutopilotDecisionResult {
  outcome: DecidedOutcome;
  decidedBy: AutopilotDecider;
  options: AutopilotOptions;
  /** The decision being applied: the model's, the rule's or the pending raise's. */
  decision: AutopilotDecision | null;
  /** What the model returned, when it returned a usable decision. */
  modelDecision: AutopilotDecision | null;
  change: CheckedChange | null;
  raise: PreparedRaise | null;
  reason: DecisionReason;
  /** The model's why after filterWhy, only when its decision is applied unadjusted; else null. */
  modelWhy: string | null;
  adjusted: boolean;
  /** proposal_rejected rows for a model decision that was rejected or adjusted. */
  rejections: GlimActionRecord[];
  issues: ValidationIssue[];
  brief: string | null;
  fixtureKey: string | null;
  /** The model that served the call, or the one asked when the call failed; null without a call. */
  model: string | null;
  usage: GlimTokenUsage;
  tokensUsed: number;
  latencyMs: number | null;
  /** A model failure, or why its decision was set aside. */
  error: string | null;
  /** Why the rule decided without asking the model. */
  ruleBecause: string | null;
}

function emptyResult(options: AutopilotOptions): AutopilotDecisionResult {
  return {
    outcome: "skipped",
    decidedBy: "none",
    options,
    decision: null,
    modelDecision: null,
    change: null,
    raise: null,
    reason: "nothing_fits",
    modelWhy: null,
    adjusted: false,
    rejections: [],
    issues: [],
    brief: null,
    fixtureKey: null,
    model: null,
    usage: NO_TOKENS,
    tokensUsed: 0,
    latencyMs: null,
    error: null,
    ruleBecause: null,
  };
}

/** Why the rule must decide without a model call, or null when the model may. */
export function ruleBecause(context: AutopilotContext, modelAllowed: AutopilotCapCheck): string | null {
  if (!modelAllowed.ok) return modelAllowed.reason;
  const primary = primaryTrigger(context.triggers);
  if (primary && primary.kind !== "hold_raised") {
    const lot = context.state.lots.find((candidate) => candidate.id === primary.lotId);
    const left = lot ? lot.closesAt.getTime() - context.state.now.getTime() : null;
    if (lot?.status === "open" && left !== null && left > 0 && left < AUTOPILOT_CAPS.closingRuleMs) return "closing_lot";
  }
  return null;
}

/** Applies a checked decision's shape to the result. */
function withCheck(
  result: AutopilotDecisionResult,
  decision: AutopilotDecision,
  check: Exclude<DecisionCheck, { ok: false }>,
  context: AutopilotContext,
): AutopilotDecisionResult {
  if (check.action === "keep") return { ...result, outcome: "keep", decision, reason: decision.reason };
  if (check.action === "change") {
    return { ...result, outcome: "change", decision, change: check, reason: decision.reason, adjusted: check.adjusted };
  }
  const main = mainMove(check.plan.atCeiling.change, context.mandate);
  return {
    ...result,
    outcome: "prepare_raise",
    decision,
    reason: decision.reason,
    adjusted: check.adjusted,
    raise: {
      amountCents: check.amountCents,
      bounds: check.plan.bounds,
      lotId: main?.lotId ?? "",
      lotNumber: main?.lotNumber ?? 0,
      lots: decision.lots,
      atCeiling: check.plan.atCeiling,
    },
  };
}

function decideByRule(result: AutopilotDecisionResult, context: AutopilotContext): AutopilotDecisionResult {
  const decision = ruleDecision(context, result.options.options);
  const check = checkDecision(decision, context);
  // The rule's own options passed this check; failing now would be a bug, and keeping is safe.
  if (!check.ok) return { ...result, decidedBy: "rule", outcome: "keep", decision, reason: "nothing_fits", issues: check.issues };
  return withCheck({ ...result, decidedBy: "rule" }, decision, check, context);
}

export async function decideAutopilot(input: DecideAutopilotInput): Promise<AutopilotDecisionResult> {
  const { context } = input;
  const options = computeOptions(context);
  let result = emptyResult(options);
  const records = (issues: readonly ValidationIssue[]) =>
    toGlimActionRecords(issues, { paddleId: context.state.guest.paddleId, holdCents: context.state.holdCents, planId: context.plan.id });

  // The guest approved the raise Glim asked for: apply that plan as is, with no model call.
  const primary = primaryTrigger(context.triggers);
  if (primary?.kind === "hold_raised" && context.pendingRaise) {
    const decision: AutopilotDecision = {
      action: "change",
      lots: context.pendingRaise.lots,
      raiseToCents: null,
      reason: "raise_needed",
      why: "",
    };
    const check = checkDecision(decision, context);
    if (check.ok && check.action === "change") {
      return withCheck({ ...result, decidedBy: "pending_raise" }, decision, check, context);
    }
  }

  if (options.options.length === 0) return result;

  const fixtureKey = fixtureKeyFor(context, options.options);
  const brief = buildBrief(context, options);
  result = { ...result, brief, fixtureKey };
  const because = ruleBecause(context, input.modelAllowed);
  if (because) return decideByRule({ ...result, ruleBecause: because }, context);

  await input.onModelCall?.();
  const timeout = AbortSignal.timeout(input.timeoutMs ?? AUTOPILOT_CAPS.modelTimeoutMs);
  const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout;
  const call = await callGlimModel(
    input.model,
    { profile: "autopilot", messages: autopilotMessages(brief), guestText: AUTOPILOT_USER_TEXT, attempt: 0, fixtureKey },
    { signal },
  );
  result = {
    ...result,
    model: call.ok ? call.message.model : input.model.mode === "recorded" ? RECORDED_MODEL : GLIM_MODEL,
    usage: call.usage,
    tokensUsed: totalTokens(call.usage),
    latencyMs: call.latencyMs,
  };
  if (!call.ok) return decideByRule({ ...result, error: [call.failure, call.detail].filter(Boolean).join(": ") }, context);

  const text = call.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  const parsed = parseDecision(text);
  if (!parsed.ok) {
    const issues: ValidationIssue[] = [
      { reason: "invalid_decision", lotNumber: null, lotId: null, amountCents: null, limitCents: null, message: parsed.message },
    ];
    return decideByRule({ ...result, error: parsed.message, issues, rejections: records(issues) }, context);
  }
  const check = checkDecision(parsed.decision, context);
  result = { ...result, modelDecision: parsed.decision };
  if (!check.ok) {
    return decideByRule(
      { ...result, error: "decision_rejected", issues: check.issues, rejections: records(check.issues) },
      context,
    );
  }
  const decided = withCheck({ ...result, decidedBy: "model" }, parsed.decision, check, context);
  return {
    ...decided,
    issues: check.adjustments,
    rejections: records(check.adjustments),
    modelWhy: check.adjusted ? null : filterWhy(parsed.decision.why),
  };
}
