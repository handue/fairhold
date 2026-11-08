/**
 * The seam between the auction and Glim: GlimState is read from the seeded fixture with the
 * engine's own commitment calculation, and the golden sentence planned on it gives 07's approved
 * card. Glim replays its recorded reply (GLIM_MODE=recorded), so no key is needed.
 */
import { describe, expect, it } from "vitest";

import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { createLimits, getBiddingPower } from "@/server/engine";
import { availableForPlan } from "@/server/glim/allocator";
import { DEFAULT_DAILY_TOKEN_BUDGET, DEFAULT_RECORDINGS_DIR } from "@/server/glim/config";
import { createRecordedGlimModel } from "@/server/glim/recorded";
import { runGlimTurn } from "@/server/glim/turn";
import { checkPlan } from "@/server/glim/validator";
import { loadGlimState } from "@/server/queries/glim-state";

import { GOLDEN_PLAN, GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";

const database = getTestDatabase();

async function jamieAt(moment: "catalog" | "paddle") {
  const fixture = await createFixtureEvent({ moment }, database.pool);
  const state = await loadGlimState({ paddleId: fixture.jamie.paddleId, now: fixture.at }, database);
  if (!state) throw new Error("Jamie's paddle was not found");
  const power = (await getBiddingPower([fixture.jamie.paddleId], database.pool)).get(fixture.jamie.paddleId);
  return { fixture, state, power };
}

/**
 * The fixture keeps the gala's real date (Nov 7, 2026), so the engine, which reads the database
 * clock, refuses its lots once that night has passed. Moving every close to an hour from now keeps
 * a test that writes through the engine independent of the day it runs.
 */
async function closeAnHourFromNow(eventId: string, at: Date) {
  await database.pool.query(
    "update lots set closes_at = closes_at + (clock_timestamp() + interval '1 hour' - $2::timestamptz) where event_id = $1",
    [eventId, at],
  );
}

describe("Glim's state from Postgres", () => {
  it("reads Jamie at 8:58 PM: $500 held, winning Chef's Table at $320, no plan yet", async () => {
    const { state, power } = await jamieAt("catalog");

    expect(state.holdCents).toBe(50_000);
    expect(state.commitments).toEqual([{ lotNumber: 7, source: "winning_bid", cents: 32_000, withoutGlimCents: 32_000 }]);
    expect(state.commitments.reduce((sum, row) => sum + row.cents, 0)).toBe(power?.committedCents);
    expect(state.plan).toBeNull();
    expect(state.favoriteLotNumbers).toEqual([12]);
    expect(state.lots).toHaveLength(24);
    expect(state.lots.find((lot) => lot.number === 7)).toMatchObject({
      currentBidCents: 32_000,
      bidCount: 12,
      nextMinimumCents: 34_000,
      guestStatus: "winning",
    });
  });

  it("plans the golden sentence within the engine's numbers: Chef's Table $380, Spa Day $120", async () => {
    const { state } = await jamieAt("catalog");

    const result = await runGlimTurn({
      state,
      transcript: [],
      guestText: GOLDEN_SENTENCE,
      usageSoFar: { paddleMessages: 0, eventMessages: 0, tokensToday: 0 },
      dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET,
      model: createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR }),
    });

    expect(result.error).toBeNull();
    expect(result.card?.type).toBe("plan");
    const items = result.card?.type === "plan" ? result.card.items : [];
    expect(items.map((item) => ({ lotNumber: item.lotNumber, maxCents: item.maxCents }))).toEqual(
      GOLDEN_PLAN.map((item) => ({ lotNumber: item.lotNumber, maxCents: item.maxCents })),
    );
  });

  it("labels Glim's limits at 9:15 PM with what removing them would free", async () => {
    const { state, power } = await jamieAt("paddle");

    expect(state.plan).toMatchObject({ status: "active", budgetCents: 50_000 });
    expect(state.commitments).toEqual([
      { lotNumber: 7, source: "glim_limit", cents: 38_000, withoutGlimCents: 38_000 },
      { lotNumber: 12, source: "glim_limit", cents: 12_000, withoutGlimCents: 9_000 },
    ]);
    expect(power).toMatchObject({ holdCents: 50_000, committedCents: 50_000, leadingCents: 47_000, reservedCents: 3_000 });
    // Dropping Spa Day from the plan frees its limit above the $90 bid that stands.
    expect(availableForPlan(50_000, state.commitments, new Set([7]))).toBe(41_000);
  });

  it("lets the engine confirm the plan change Glim validates: keep Chef's Table at its limit, skip the spa", async () => {
    const { fixture, state } = await jamieAt("paddle");
    await closeAnHourFromNow(fixture.event.id, fixture.at);
    const lotId = (number: number) => state.lots.find((lot) => lot.number === number)?.id ?? "";

    const check = checkPlan(
      { tool: "propose_change", budgetCents: null, items: [{ lotNumber: 7, priority: 1, capCents: 38_000 }] },
      state,
    );
    expect(check.issues).toEqual([]);
    const items = (check.allocation?.items ?? []).map((item) => ({ lotId: item.lot.id, maxCents: item.maxCents }));
    expect(items).toEqual([{ lotId: lotId(7), maxCents: 38_000 }]);

    const confirmed = await createLimits(fixture.jamie.paddleId, items, { pool: database.pool, removeLotIds: [lotId(12)] });
    expect(confirmed).toMatchObject({ ok: true, bids: [], limits: [{ maxCents: 38_000, active: true }] });
    // The $90 spa bid stands; its $30 of Glim's room is free again.
    expect((await getBiddingPower([fixture.jamie.paddleId], database.pool)).get(fixture.jamie.paddleId)).toMatchObject({
      committedCents: 47_000,
      availableCents: 3_000,
    });
  });
});
