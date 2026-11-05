import { z } from "zod";

type EnvSource = Record<string, string | undefined>;

export const LOCAL_DATABASE_URL = "postgres://postgres:postgres@localhost:54329/fairhold_dev";

/**
 * Keyless local mode: outside production the app runs with no env file at all. The secrets are
 * placeholders; production never sees them because it must set every value explicitly.
 */
const DEVELOPMENT_DEFAULTS: EnvSource = {
  DATABASE_URL: LOCAL_DATABASE_URL,
  SESSION_SECRET: "dev-only-".repeat(4),
  CRON_SECRET: "dev-only-".repeat(4),
};

const databaseUrlSchema = z.url({
  protocol: /^postgres(ql)?$/,
  error: "must be a postgres:// URL",
});

const secretSchema = z.string().min(32, "must be at least 32 characters");

/** Glim's tokens across every event per UTC day, before it answers with the fallback line. */
export const DEFAULT_GLIM_DAILY_TOKEN_BUDGET = 1_000_000;

const positiveWholeNumberSchema = z
  .string()
  .regex(/^\d+$/, "must be a positive whole number")
  .transform(Number)
  .pipe(z.number().int().positive("must be a positive whole number").max(Number.MAX_SAFE_INTEGER));

const serverEnvSchema = z
  .object({
    DATABASE_URL: databaseUrlSchema,
    PAYMENTS_MODE: z.enum(["simulated", "sandbox"]).default("simulated"),
    // Live PayPal is out of scope, so anything but the sandbox is a configuration error.
    PAYPAL_ENV: z.literal("sandbox").default("sandbox"),
    PAYPAL_CLIENT_ID: z.string().optional(),
    PAYPAL_CLIENT_SECRET: z.string().optional(),
    PAYPAL_WEBHOOK_ID: z.string().optional(),
    GLIM_MODE: z.enum(["live", "recorded"]).default("recorded"),
    ANTHROPIC_API_KEY: z.string().optional(),
    GLIM_DAILY_TOKEN_BUDGET: positiveWholeNumberSchema.default(DEFAULT_GLIM_DAILY_TOKEN_BUDGET),
    SESSION_SECRET: secretSchema,
    CRON_SECRET: secretSchema,
    DEMO_BUYER_1_EMAIL: z.email().optional(),
    DEMO_BUYER_1_PASSWORD: z.string().optional(),
    DEMO_BUYER_2_EMAIL: z.email().optional(),
    DEMO_BUYER_2_PASSWORD: z.string().optional(),
    DEMO_BUYER_3_EMAIL: z.email().optional(),
    DEMO_BUYER_3_PASSWORD: z.string().optional(),
    ENGINE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((env, ctx) => {
    const requireKey = (key: keyof typeof env, condition: string) => {
      if (!env[key]) {
        ctx.addIssue({ code: "custom", path: [key], message: `is required when ${condition}` });
      }
    };
    if (env.PAYMENTS_MODE === "sandbox") {
      requireKey("PAYPAL_CLIENT_ID", "PAYMENTS_MODE=sandbox");
      requireKey("PAYPAL_CLIENT_SECRET", "PAYMENTS_MODE=sandbox");
    }
    if (env.GLIM_MODE === "live") {
      requireKey("ANTHROPIC_API_KEY", "GLIM_MODE=live");
    }
  });

export type ServerEnv = z.output<typeof serverEnvSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

/** `KEY=` in an env file means "unset", so it falls back to the default instead of failing. */
function withoutEmptyValues(source: EnvSource): EnvSource {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
}

function resolveSource(source: EnvSource): EnvSource {
  const values = withoutEmptyValues(source);
  return values.NODE_ENV === "production" ? values : { ...DEVELOPMENT_DEFAULTS, ...values };
}

function parseEnv<Schema extends z.ZodType>(schema: Schema, source: EnvSource): z.output<Schema> {
  const result = schema.safeParse(resolveSource(source));
  if (result.success) return result.data;
  // Zod issues name the variable and the rule, never the value, so secrets stay out of logs.
  const problems = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
  throw new EnvError(`Invalid environment configuration:\n${problems.join("\n")}`);
}

export function parseServerEnv(source: EnvSource): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}

let cachedServerEnv: ServerEnv | undefined;

/** The validated server environment, parsed once per process. */
export function getServerEnv(): ServerEnv {
  cachedServerEnv ??= parseServerEnv(process.env);
  return cachedServerEnv;
}

const developmentSwitchesSchema = z.object({
  UI_FIXTURE: z.literal("riverside").optional(),
  FREEZE_CLOCK_AT: z.iso
    .datetime({ offset: true, error: "must be an ISO 8601 instant, e.g. 2026-11-08T04:58:00Z" })
    .transform((value) => Date.parse(value))
    .optional(),
});

export interface DevelopmentSwitches {
  /** UI_FIXTURE=riverside: the guest pages read the approved fixture instead of Postgres. */
  uiFixture: "riverside" | null;
  /** FREEZE_CLOCK_AT: the instant (epoch ms) the guest pages' clock stops at, for a seeded fixture. */
  freezeClockAt: number | null;
}

const NO_SWITCHES: DevelopmentSwitches = { uiFixture: null, freezeClockAt: null };

/**
 * Design and visual-check switches. Production ignores them whatever they are set to; elsewhere
 * they are read on every call, so a test can change them.
 */
export function getDevelopmentSwitches(source: EnvSource = process.env): DevelopmentSwitches {
  if (source.NODE_ENV === "production") return NO_SWITCHES;
  const env = parseEnv(developmentSwitchesSchema, source);
  return { uiFixture: env.UI_FIXTURE ?? null, freezeClockAt: env.FREEZE_CLOCK_AT ?? null };
}

/**
 * Only DATABASE_URL, for code that needs nothing else (migrations, scripts, the pool), so a
 * missing PayPal key never blocks a migration.
 */
export function getDatabaseUrl(source: EnvSource = process.env): string {
  return parseEnv(z.object({ DATABASE_URL: databaseUrlSchema }), source).DATABASE_URL;
}
