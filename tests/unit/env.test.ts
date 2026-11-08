import { describe, expect, it } from "vitest";

import { getDatabaseUrl, getDevelopmentSwitches, LOCAL_DATABASE_URL, parseServerEnv } from "@/server/lib/env";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://app:app@db.internal:5432/fairhold",
  SESSION_SECRET: "s".repeat(32),
  CRON_SECRET: "c".repeat(32),
};

describe("parseServerEnv", () => {
  it("runs keyless outside production", () => {
    const env = parseServerEnv({ NODE_ENV: "development" });
    expect(env.DATABASE_URL).toBe(LOCAL_DATABASE_URL);
    expect(env.PAYMENTS_MODE).toBe("simulated");
    expect(env.PAYPAL_ENV).toBe("sandbox");
    expect(env.GLIM_MODE).toBe("recorded");
    expect(env.ENGINE_ENABLED).toBe(false);
  });

  it("requires the database URL and both secrets in production", () => {
    expect(() => parseServerEnv({ NODE_ENV: "production" })).toThrow(
      /DATABASE_URL[\s\S]*SESSION_SECRET[\s\S]*CRON_SECRET/,
    );
  });

  it("treats empty values as unset", () => {
    const env = parseServerEnv({ ...production, PAYMENTS_MODE: "", ENGINE_ENABLED: " " });
    expect(env.PAYMENTS_MODE).toBe("simulated");
    expect(env.ENGINE_ENABLED).toBe(false);
  });

  it("accepts only the PayPal sandbox", () => {
    expect(() => parseServerEnv({ ...production, PAYPAL_ENV: "live" })).toThrow(/PAYPAL_ENV/);
  });

  it("requires PayPal credentials for sandbox payments", () => {
    expect(() => parseServerEnv({ ...production, PAYMENTS_MODE: "sandbox" })).toThrow(
      /PAYPAL_CLIENT_ID[\s\S]*PAYPAL_CLIENT_SECRET/,
    );
    const env = parseServerEnv({
      ...production,
      PAYMENTS_MODE: "sandbox",
      PAYPAL_CLIENT_ID: "client-id",
      PAYPAL_CLIENT_SECRET: "client-secret",
    });
    expect(env.PAYMENTS_MODE).toBe("sandbox");
  });

  it("requires an Anthropic key for live Glim", () => {
    expect(() => parseServerEnv({ ...production, GLIM_MODE: "live" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("enables the engine only for the exact value true", () => {
    expect(parseServerEnv({ ...production, ENGINE_ENABLED: "true" }).ENGINE_ENABLED).toBe(true);
    expect(() => parseServerEnv({ ...production, ENGINE_ENABLED: "yes" })).toThrow(/ENGINE_ENABLED/);
  });

  it("runs Glim's autopilot unless GLIM_AUTOPILOT=off", () => {
    expect(parseServerEnv(production).GLIM_AUTOPILOT).toBe("on");
    expect(parseServerEnv({ ...production, GLIM_AUTOPILOT: "off" }).GLIM_AUTOPILOT).toBe("off");
    expect(() => parseServerEnv({ ...production, GLIM_AUTOPILOT: "false" })).toThrow(/GLIM_AUTOPILOT/);
  });

  it("gives Glim a daily token budget of 1,000,000 unless set to a positive whole number", () => {
    expect(parseServerEnv(production).GLIM_DAILY_TOKEN_BUDGET).toBe(1_000_000);
    expect(parseServerEnv({ ...production, GLIM_DAILY_TOKEN_BUDGET: "250000" }).GLIM_DAILY_TOKEN_BUDGET).toBe(250_000);
    for (const invalid of ["0", "-5", "1e6", "lots"]) {
      expect(() => parseServerEnv({ ...production, GLIM_DAILY_TOKEN_BUDGET: invalid })).toThrow(/GLIM_DAILY_TOKEN_BUDGET/);
    }
  });

  it("never repeats a rejected value in the error", () => {
    const rejected = "too-short-but-private";
    expect(() => parseServerEnv({ ...production, SESSION_SECRET: rejected })).toThrow(/SESSION_SECRET/);
    expect(() => parseServerEnv({ ...production, SESSION_SECRET: rejected })).not.toThrow(rejected);
  });
});

describe("getDatabaseUrl", () => {
  it("needs nothing but the database URL", () => {
    expect(getDatabaseUrl({ NODE_ENV: "production", DATABASE_URL: production.DATABASE_URL })).toBe(
      production.DATABASE_URL,
    );
  });

  it("rejects URLs that are not Postgres", () => {
    expect(() => getDatabaseUrl({ DATABASE_URL: "mysql://db.internal/fairhold" })).toThrow(/DATABASE_URL/);
  });
});

describe("getDevelopmentSwitches", () => {
  it("reads the fixture switch and the frozen clock outside production", () => {
    expect(getDevelopmentSwitches({ NODE_ENV: "development" })).toEqual({ uiFixture: null, freezeClockAt: null });
    expect(
      getDevelopmentSwitches({ NODE_ENV: "development", UI_FIXTURE: "riverside", FREEZE_CLOCK_AT: "2026-11-08T04:58:00Z" }),
    ).toEqual({ uiFixture: "riverside", freezeClockAt: Date.parse("2026-11-08T04:58:00Z") });
  });

  it("rejects a fixture or an instant it does not know", () => {
    expect(() => getDevelopmentSwitches({ UI_FIXTURE: "gala" })).toThrow(/UI_FIXTURE/);
    expect(() => getDevelopmentSwitches({ FREEZE_CLOCK_AT: "tonight" })).toThrow(/FREEZE_CLOCK_AT/);
  });

  it("ignores both in production, whatever they are set to", () => {
    expect(getDevelopmentSwitches({ NODE_ENV: "production", UI_FIXTURE: "gala", FREEZE_CLOCK_AT: "tonight" })).toEqual({
      uiFixture: null,
      freezeClockAt: null,
    });
  });
});
