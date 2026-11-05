import path from "node:path";

import { DEFAULT_GLIM_DAILY_TOKEN_BUDGET, parseServerEnv } from "@/server/lib/env";

type EnvSource = Record<string, string | undefined>;

/** Switching to claude-sonnet-5-5 is a one-line change and the user's call (build plan, section 2). */
export const GLIM_MODEL = "claude-opus-5-5";
/** Opus 5.5 always thinks; low is the floor and must be explicit, since the default is medium. */
export const GLIM_EFFORT = "low";
/** Thinking counts toward max_tokens, so this leaves room for it plus a reply and one tool call. */
export const GLIM_MAX_TOKENS = 8_192;
/** Gates the scalar `fallbacks: "default"` form; the array form needs a different header. */
export const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const DEFAULT_DAILY_TOKEN_BUDGET = DEFAULT_GLIM_DAILY_TOKEN_BUDGET;
export const DEFAULT_RECORDINGS_DIR = path.join(process.cwd(), "tests", "fixtures", "glim", "recorded");

export type GlimMode = "live" | "recorded";

export interface GlimConfig {
  mode: GlimMode;
  apiKey: string | undefined;
  dailyTokenBudget: number;
  recordingsDir: string;
}

/** GLIM_MODE, ANTHROPIC_API_KEY (required in live mode) and GLIM_DAILY_TOKEN_BUDGET, from the shared server env. */
export function parseGlimConfig(source: EnvSource): GlimConfig {
  const env = parseServerEnv(source);
  return {
    mode: env.GLIM_MODE,
    apiKey: env.ANTHROPIC_API_KEY,
    dailyTokenBudget: env.GLIM_DAILY_TOKEN_BUDGET,
    recordingsDir: DEFAULT_RECORDINGS_DIR,
  };
}

let cachedConfig: GlimConfig | undefined;

export function getGlimConfig(): GlimConfig {
  cachedConfig ??= parseGlimConfig(process.env);
  return cachedConfig;
}
