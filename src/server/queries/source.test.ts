import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { closeDatabaseClient } from "@/server/db/client";
import { FIXTURE_NOW, riversideFixtureSource } from "@/ui/__fixtures__/riverside";

import { getGuestReadSource } from "./source";

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await closeDatabaseClient();
});

describe("getGuestReadSource", () => {
  it("reads the approved fixture with UI_FIXTURE=riverside", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");
    const source = await getGuestReadSource();
    expect(await source.currentTime()).toBe(FIXTURE_NOW);
    expect(await source.findEvent("riverside-shelter-gala")).toMatchObject({ name: "Riverside Shelter Gala" });
  });

  it("freezes the clock with FREEZE_CLOCK_AT", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");
    vi.stubEnv("FREEZE_CLOCK_AT", "2026-11-08T05:15:40Z");
    const source = await getGuestReadSource();
    expect(await source.currentTime()).toBe(Date.parse("2026-11-08T05:15:40Z"));
  });

  it("rejects a clock it cannot read", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");
    vi.stubEnv("FREEZE_CLOCK_AT", "tonight");
    await expect(getGuestReadSource()).rejects.toThrow(/FREEZE_CLOCK_AT/);
  });

  it("ignores both switches in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Never connected to: the pool opens connections on first query only.
    vi.stubEnv("DATABASE_URL", "postgres://nobody:nothing@127.0.0.1:9/none");
    vi.stubEnv("UI_FIXTURE", "riverside");
    vi.stubEnv("FREEZE_CLOCK_AT", "tonight");
    const source = await getGuestReadSource();
    expect(source).not.toBe(riversideFixtureSource);
    expect(Object.keys(source)).toEqual(Object.keys(riversideFixtureSource));
  });
});
