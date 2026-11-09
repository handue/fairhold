/**
 * Review finding (Nov 7, autopilot): applyAutopilotChange is meant to be the last line of
 * enforcement on its own (docs/planning/glim-autopilot.md §5.2 step 4, §10 "raw engine changes sent
 * straight to applyAutopilotChange, bypassing the validator"). Under its lot locks it runs
 * mandateViolations on `change.after`, but the engine is handed `change.set`
 * (src/server/plans/apply.ts, steps 4 and 6). Nothing checks that every lot and maximum in `set`
 * is also in `after`, so a change whose two lists disagree writes a Glim limit outside the mandate,
 * or above the guest's cap, and commits it. The Postgres property test cannot see this: its raw
 * changes all come from buildChange, where `set` is always a subset of `after`.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { AutopilotChange } from "@/server/glim/autopilot/types";
import { liveGlimLimits } from "@/server/glim/autopilot/validate";
import { applyAutopilotChange, type ApplyAutopilotInput } from "@/server/plans/apply";
import { loadAutopilotRead } from "@/server/plans/context";

import { getTestDatabase } from "../../helpers/database";
import { createLot } from "../engine/support/fixtures";
import { bid, createGala, heart, rows, startBidding, type Gala } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;

/** The golden beat up to the rival's $400 on Chef's Table: Glim keeps Spa Day at its $120 cap. */
async function exhausted() {
  const gala = await createGala(pool);
  await heart(pool, gala.jamie, gala.lots.wine);
  const { confirmed } = await startBidding(database, gala.jamie);
  await bid(pool, gala.rival, gala.lots.chef, 40_000);
  const read = await loadAutopilotRead(gala.jamie, [], database);
  if (!read?.context) throw new Error("no context");
  return { gala, planId: confirmed.planId, context: read.context };
}

function input(gala: Gala, planId: string, change: AutopilotChange): ApplyAutopilotInput {
  const runId = randomUUID();
  return {
    runId,
    paddleId: gala.jamie,
    eventId: gala.eventId,
    planId,
    planVersion: 1,
    change,
    describe: (_applied, ids) => ({
      action: { lotId: null, amountCents: null, limitCents: null, chip: "none", message: "review change", detail: { runId } },
      card: { type: "autopilot", actionId: ids.actionId },
    }),
    run: {
      id: runId,
      paddleId: gala.jamie,
      eventId: gala.eventId,
      planId,
      triggers: [],
      decidedBy: "rule",
      model: null,
      brief: null,
      error: null,
      decision: null,
      issues: null,
      planVersionBefore: 1,
      latencyMs: null,
      usage: null,
      tokensUsed: 0,
      startedAt: new Date(),
    },
    pool,
  };
}

const spaKept = (gala: Gala) => ({
  lotId: gala.lots.spa,
  lotNumber: 12,
  shortTitle: "Spa Day",
  priority: 2,
  capCents: 12_000,
  floorCents: 9_000,
  maxCents: 12_000,
});

describe("the apply transaction checks the limits it writes (review)", () => {
  it("never writes a Glim limit on a lot outside the mandate, whatever `after` says", async () => {
    const { gala, planId, context } = await exhausted();
    const cabin = await createLot(pool, gala.eventId, { number: 3, startingBidCents: 5_000, minRaiseCents: 1_000 });
    const live = liveGlimLimits(context);
    const change: AutopilotChange = {
      after: [spaKept(gala)],
      before: [...live.values()].map((limit) => ({ lotId: limit.lotId, lotNumber: limit.lotNumber, maxCents: limit.maxCents })),
      set: [{ lotId: cabin, lotNumber: 3, maxCents: 10_000 }],
      removeLotIds: [],
      lowerOrDropOnly: false,
    };

    const result = await applyAutopilotChange(input(gala, planId, change));

    expect(result.outcome).toBe("refused");
    expect(await rows(pool, "select max_cents from bid_limits where paddle_id = $1 and lot_id = $2 and owner = 'glim' and active", [gala.jamie, cabin])).toEqual(
      [],
    );
  });

  it("never writes a Glim limit above the guest's cap, whatever `after` says", async () => {
    const { gala, planId, context } = await exhausted();
    const live = liveGlimLimits(context);
    // `after` keeps Spa Day at its $120 cap; `set` hands the engine $200 for it.
    const change: AutopilotChange = {
      after: [spaKept(gala)],
      before: [...live.values()].map((limit) => ({ lotId: limit.lotId, lotNumber: limit.lotNumber, maxCents: limit.maxCents })),
      set: [{ lotId: gala.lots.spa, lotNumber: 12, maxCents: 20_000 }],
      removeLotIds: [],
      lowerOrDropOnly: false,
    };

    const result = await applyAutopilotChange(input(gala, planId, change));

    expect(result.outcome).toBe("refused");
    expect(
      await rows(pool, "select max_cents from bid_limits where paddle_id = $1 and lot_id = $2 and owner = 'glim' and active", [gala.jamie, gala.lots.spa]),
    ).toEqual([{ max_cents: 12_000 }]);
  });
});
