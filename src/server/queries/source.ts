import { getDb } from "@/server/db/client";
import { getDevelopmentSwitches } from "@/server/lib/env";

import { createPostgresGuestSource } from "./postgres-source";
import type { GuestReadSource } from "./types";

/**
 * Where the guest pages read from: Postgres in production. Two switches exist for design work and
 * visual checks, and neither works in production (see getDevelopmentSwitches):
 *
 * - UI_FIXTURE=riverside reads the approved Jamie state from src/ui/__fixtures__ instead of the
 *   database, at its own frozen moment (8:58 PM).
 * - FREEZE_CLOCK_AT=<ISO instant> stops the clock the pages read at that instant, so a seeded
 *   fixture's countdowns read as approved (npm run db:seed prints the instant to use).
 */
export async function getGuestReadSource(): Promise<GuestReadSource> {
  const { uiFixture, freezeClockAt } = getDevelopmentSwitches();
  const source =
    uiFixture === "riverside"
      ? (await import("@/ui/__fixtures__/riverside")).riversideFixtureSource
      : createPostgresGuestSource(getDb());
  return freezeClockAt === null ? source : { ...source, currentTime: async () => freezeClockAt };
}
