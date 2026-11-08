/**
 * Cost caps, checked before any model call: messages per paddle, messages per event, and a daily
 * token budget across every event (GLIM_DAILY_TOKEN_BUDGET). The Anthropic console's monthly
 * spend limit sits behind all three.
 */

export const GLIM_MESSAGE_CAPS = { perPaddle: 40, perEvent: 300 } as const;

/** Counts before the current message, from chat_messages. */
export interface GlimUsageSoFar {
  /** Guest messages this paddle has sent Glim. */
  paddleMessages: number;
  /** Guest messages sent to Glim across the paddle's event. */
  eventMessages: number;
  /**
   * Tokens spent since startOfTokenDay(now): chat replies and autopilot runs together, from
   * tokensToday in src/server/plans/usage.ts, the one count both use.
   */
  tokensToday: number;
}

export type CapReason = "paddle_messages" | "event_messages" | "daily_tokens";

export type CapCheck = { ok: true } | { ok: false; reason: CapReason };

export function checkGlimCaps(usage: GlimUsageSoFar, dailyTokenBudget: number): CapCheck {
  if (usage.paddleMessages >= GLIM_MESSAGE_CAPS.perPaddle) return { ok: false, reason: "paddle_messages" };
  if (usage.eventMessages >= GLIM_MESSAGE_CAPS.perEvent) return { ok: false, reason: "event_messages" };
  if (usage.tokensToday >= dailyTokenBudget) return { ok: false, reason: "daily_tokens" };
  return { ok: true };
}

/** The token budget resets at midnight UTC, so the window is the same on every instance. */
export function startOfTokenDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Glim's autopilot (docs/planning/glim-autopilot.md §7). */
export const AUTOPILOT_CAPS = {
  /** Model decisions per paddle per event; then the rule decides. */
  modelDecisionsPerPaddle: 12,
  /** Model decisions per event; then the rule decides. */
  modelDecisionsPerEvent: 150,
  /** At least this long between two model calls for one paddle; sooner, the rule decides. */
  modelGapMs: 10_000,
  /** The model is called only while today's chat and autopilot tokens are under this share of the budget. */
  dailyTokenShare: 0.6,
  /** Applied changes per paddle per event; then autopilot stops for that paddle. */
  appliedChangesPerPaddle: 15,
  /** Runs one process starts at once; the rest wait for the next tick. */
  concurrentRuns: 4,
  /** A model call is aborted after this long, and the rule decides. */
  modelTimeoutMs: 15_000,
  /** When the run's main lot closes sooner than this, the rule decides without a model call. */
  closingRuleMs: 25_000,
} as const;

/** Counts before this run, from glim_autopilot_runs, glim_autopilot and tokensToday. */
export interface AutopilotUsageSoFar {
  paddleModelDecisions: number;
  eventModelDecisions: number;
  lastModelCallAt: Date | null;
  /** Chat and autopilot tokens since startOfTokenDay(now). */
  tokensToday: number;
}

export type AutopilotCapReason = "paddle_decisions" | "event_decisions" | "model_gap" | "daily_tokens";

export type AutopilotCapCheck = { ok: true } | { ok: false; reason: AutopilotCapReason };

/** Whether this run may call the model; when not, the deterministic rule decides. */
export function checkAutopilotModel(usage: AutopilotUsageSoFar, dailyTokenBudget: number, now: Date): AutopilotCapCheck {
  if (usage.paddleModelDecisions >= AUTOPILOT_CAPS.modelDecisionsPerPaddle) return { ok: false, reason: "paddle_decisions" };
  if (usage.eventModelDecisions >= AUTOPILOT_CAPS.modelDecisionsPerEvent) return { ok: false, reason: "event_decisions" };
  if (usage.lastModelCallAt && now.getTime() - usage.lastModelCallAt.getTime() < AUTOPILOT_CAPS.modelGapMs) {
    return { ok: false, reason: "model_gap" };
  }
  if (usage.tokensToday >= dailyTokenBudget * AUTOPILOT_CAPS.dailyTokenShare) return { ok: false, reason: "daily_tokens" };
  return { ok: true };
}
