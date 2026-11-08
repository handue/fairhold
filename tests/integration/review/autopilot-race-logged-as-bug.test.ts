/**
 * Review finding (Nov 7, autopilot): a mandate hit under the apply transaction's locks is logged to
 * error_log as `autopilot_validator_bug` ("the validator should have stopped it"). The builder
 * moved one race out of that path (a target lot closing during the decision becomes `lot_closed`),
 * but two ordinary races still land there:
 *   - the guest sets their own "Max…" on a lot the change keeps (unchanged, so it is neither locked
 *     nor fenced as "written"), and mandateViolations then reports guest_controlled_lot on
 *     `change.after`; the spec's race table says a guest max during the decision ends the run
 *     `stale` (docs/planning/glim-autopilot.md §5.4);
 *   - a lot of a prepared raise comes within 5 s of its close while the model decides;
 *     prepareAutopilotRaise has no race branch, so closes_too_soon is logged as a validator bug.
 * The control room's "Glim stayed inside every guest's rules" check (V6) and anyone reading
 * error_log would count these as Glim breaking a guest's rules.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { setMaxBid } from "@/server/engine";
import type { AutopilotDecisionLot } from "@/server/glim/autopilot/types";
import { checkDecision } from "@/server/glim/autopilot/validate";
import { applyAutopilotChange, prepareAutopilotRaise } from "@/server/plans/apply";
import { loadAutopilotRead } from "@/server/plans/context";

import { getTestDatabase } from "../../helpers/database";
import { goldenProposal, modelReply, scriptedModel, toolUseBlock } from "../../unit/glim/helpers";
import { bid, createGala, heart, rows, startBidding, type Gala } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;

function runFields(gala: Gala, planId: string, runId: string) {
  return {
    id: runId,
    paddleId: gala.jamie,
    eventId: gala.eventId,
    planId,
    triggers: [],
    decidedBy: "model" as const,
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
  };
}

const GOLDEN: AutopilotDecisionLot[] = [
  { lotNumber: 12, priority: 2, maxCents: null },
  { lotNumber: 9, priority: 3, maxCents: null },
];

describe("races under the apply locks are not validator bugs (review)", () => {
  it("ends stale, with no validator-bug log, when the guest sets their own max on a lot the change keeps", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    const { confirmed } = await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    const read = await loadAutopilotRead(gala.jamie, [], database);
    if (!read?.context) throw new Error("no context");
    const check = checkDecision({ action: "change", lots: GOLDEN, raiseToCents: null, reason: "top_lot_out_of_reach", why: "" }, read.context);
    if (check.action !== "change") throw new Error(`expected a change, got ${check.action}`);
    // The golden move keeps Spa Day as it is and adds Wine Tasting.
    expect(check.change.set.map((lot) => lot.lotId)).toEqual([gala.lots.wine]);

    // While the model decided, Jamie set her own $100 max on Spa Day.
    expect((await setMaxBid(gala.jamie, gala.lots.spa, 10_000, { pool })).ok).toBe(true);

    const runId = randomUUID();
    const result = await applyAutopilotChange({
      runId,
      paddleId: gala.jamie,
      eventId: gala.eventId,
      planId: confirmed.planId,
      planVersion: 1,
      change: check.change,
      describe: (_applied, ids) => ({
        action: { lotId: null, amountCents: null, limitCents: null, chip: "none", message: "review", detail: { runId } },
        card: { type: "autopilot", actionId: ids.actionId },
      }),
      run: runFields(gala, confirmed.planId, runId),
      pool,
    });

    expect(await rows(pool, "select code from error_log where paddle_id = $1", [gala.jamie])).toEqual([]);
    expect(result).toMatchObject({ outcome: "stale" });
  });

  it("refuses a prepared raise whose lot came within 5 s of closing as a race, with no validator-bug log", async () => {
    const gala = await createGala(pool);
    let call = 0;
    const chat = scriptedModel(() => modelReply([toolUseBlock("propose_plan", goldenProposal(call++ === 0 ? 800 : 500))]));
    const { confirmed } = await startBidding(database, gala.jamie, {
      guestText: "$800. I really want the chef's dinner. Spa only under $120.",
      model: chat.model,
    });
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    const read = await loadAutopilotRead(gala.jamie, [], database);
    if (!read?.context) throw new Error("no context");
    const lots: AutopilotDecisionLot[] = [
      { lotNumber: 7, priority: 1, maxCents: null },
      { lotNumber: 12, priority: 2, maxCents: null },
    ];
    const check = checkDecision({ action: "prepare_raise", lots, raiseToCents: 60_000, reason: "raise_needed", why: "" }, read.context);
    if (check.action !== "prepare_raise") throw new Error(`expected a raise, got ${check.action}`);

    // While the model decided, Chef's Table came within 5 s of its close.
    await pool.query("update lots set closes_at = now() + interval '3 seconds' where id = $1", [gala.lots.chef]);

    const runId = randomUUID();
    const result = await prepareAutopilotRaise({
      runId,
      paddleId: gala.jamie,
      eventId: gala.eventId,
      planId: confirmed.planId,
      planVersion: 1,
      amountCents: check.amountCents,
      change: check.plan.atCeiling.change,
      intent: lots,
      describe: (ids) => ({
        action: { lotId: gala.lots.chef, amountCents: check.amountCents, limitCents: null, chip: "none", message: "review", detail: { runId } },
        card: { type: "autopilot_raise", actionId: ids.actionId },
      }),
      run: runFields(gala, confirmed.planId, runId),
      pool,
    });

    expect(result.outcome).toBe("refused");
    expect(await rows(pool, "select code from error_log where paddle_id = $1", [gala.jamie])).toEqual([]);
  });
});
