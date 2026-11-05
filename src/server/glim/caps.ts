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
  /** Tokens spent since startOfTokenDay(now), from tokensUsed of each stored reply. */
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
