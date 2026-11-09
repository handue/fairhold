/**
 * When autopilot must not run (docs/planning/glim-autopilot.md §3.4): a paused plan, a simulated
 * paddle, an event that is not live and a plan without a mandate are never scanned and are
 * skipped if claimed; a pending plan card suspends autopilot for two minutes; the model caps hand
 * the decision to the rule; 15 applied changes stop autopilot for the paddle. The model is never
 * called in any of these.
 */
import { describe, expect, it } from "vitest";

import type { AutopilotTrigger } from "@/server/glim/autopilot/types";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";

import { bid, createGala, forbiddenModel, handClaim, heart, makeDue, recordedModel, rows, startBidding } from "./support";

const database = getTestDatabase();
const { pool } = database;

/** The golden beat up to the rival's $400, ready to wake Glim. */
async function goldenExhausted() {
  const gala = await createGala(pool);
  await heart(pool, gala.jamie, gala.lots.wine);
  const { confirmed } = await startBidding(database, gala.jamie);
  await bid(pool, gala.rival, gala.lots.chef, 40_000);
  const trigger: AutopilotTrigger = {
    kind: "limit_exhausted",
    eventLogId: "0",
    lotId: gala.lots.chef,
    lotNumber: 7,
    limitCents: 38_000,
    currentBidCents: 40_000,
  };
  return { gala, planId: confirmed.planId, trigger };
}

async function triggersQueued(paddleId: string): Promise<number> {
  await scanFacts(pool);
  const [row] = await rows<{ count: number }>(pool, "select jsonb_array_length(reasons) as count from glim_autopilot where paddle_id = $1", [paddleId]);
  return row?.count ?? 0;
}

async function runGated(paddleId: string, eventId: string, trigger: AutopilotTrigger) {
  const model = forbiddenModel();
  const report = await runAutopilot(handClaim(paddleId, eventId, [trigger]), { database, model });
  expect(model.calls).toBe(0);
  return report;
}

describe("autopilot gates", () => {
  it("skips a paused plan, and never scans it", async () => {
    const { gala, planId, trigger } = await goldenExhausted();
    await pool.query("update glim_plans set status = 'paused', version = version + 1 where id = $1", [planId]);
    expect(await triggersQueued(gala.jamie)).toBe(0);
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "skipped", reason: "plan_not_active" });
  });

  it("skips a simulated paddle, and never scans it", async () => {
    const { gala, trigger } = await goldenExhausted();
    await pool.query("update paddles set is_simulated = true where id = $1", [gala.jamie]);
    expect(await triggersQueued(gala.jamie)).toBe(0);
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "skipped", reason: "simulated_paddle" });
  });

  it("skips an event that is not live, and never scans it", async () => {
    const { gala, trigger } = await goldenExhausted();
    await pool.query("update events set status = 'closed' where id = $1", [gala.eventId]);
    expect(await triggersQueued(gala.jamie)).toBe(0);
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "skipped", reason: "event_not_live" });
  });

  it("skips a plan without a mandate, and never scans it", async () => {
    const { gala, planId, trigger } = await goldenExhausted();
    await pool.query("update glim_plans set mandate = null where id = $1", [planId]);
    expect(await triggersQueued(gala.jamie)).toBe(0);
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "skipped", reason: "no_mandate" });
  });

  it("waits while a plan card younger than two minutes is unconfirmed, then runs", async () => {
    const { gala, trigger } = await goldenExhausted();
    await pool.query(
      "insert into glim_plans (paddle_id, status, budget_cents, proposal) values ($1, 'proposed', 50000, '{}'::jsonb)",
      [gala.jamie],
    );
    expect(await triggersQueued(gala.jamie)).toBe(1);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("not due");
    const model = forbiddenModel();
    expect(await runAutopilot(claim, { database, model })).toMatchObject({ outcome: "skipped", reason: "pending_card" });
    // Re-queued for when the card is two minutes old.
    const [queued] = await rows<{ reasons: unknown[]; due_in: number; running: boolean }>(
      pool,
      `select reasons, extract(epoch from due_at - now())::float8 as due_in, running_since is not null as running
       from glim_autopilot where paddle_id = $1`,
      [gala.jamie],
    );
    expect(queued?.reasons).toHaveLength(1);
    expect(queued?.running).toBe(false);
    expect(queued?.due_in).toBeGreaterThan(110);
    expect(queued?.due_in).toBeLessThan(125);
    // Once the card is old, the same facts run.
    await pool.query("update glim_plans set created_at = now() - interval '3 minutes' where paddle_id = $1 and status = 'proposed'", [gala.jamie]);
    await makeDue(pool, gala.jamie);
    const [again] = await claimDue(pool, { limit: 4 });
    if (!again) throw new Error("not due again");
    expect(await runAutopilot(again, { database, model: recordedModel })).toMatchObject({ outcome: "applied", decidedBy: "model" });
    expect(model.calls).toBe(0);
    void trigger;
  });

  it("lets the rule decide when the model caps are reached", async () => {
    const { gala, trigger } = await goldenExhausted();
    for (let index = 0; index < 12; index += 1) {
      await pool.query(
        `insert into glim_autopilot_runs (id, paddle_id, event_id, triggers, outcome, decided_by, model)
         values (gen_random_uuid(), $1, $2, '[]'::jsonb, 'kept', 'model', 'claude-opus-5-5')`,
        [gala.jamie, gala.eventId],
      );
    }
    const report = await runGated(gala.jamie, gala.eventId, trigger);
    expect(report).toMatchObject({ outcome: "applied", decidedBy: "rule" });
    expect(report.decision?.ruleBecause).toBe("paddle_decisions");
  });

  it("lets the rule decide within 10 s of the last model call", async () => {
    const { gala, trigger } = await goldenExhausted();
    await pool.query("update glim_autopilot set last_model_call_at = now() - interval '5 seconds' where paddle_id = $1", [gala.jamie]);
    expect((await runGated(gala.jamie, gala.eventId, trigger)).decision?.ruleBecause).toBe("model_gap");
  });

  it("stops after 15 applied changes this event, silently", async () => {
    const { gala, planId, trigger } = await goldenExhausted();
    for (let index = 0; index < 15; index += 1) {
      await pool.query(
        `insert into glim_actions (paddle_id, plan_id, kind, decision, message) values ($1, $2, 'autopilot_changed', 'executed', 'earlier')`,
        [gala.jamie, planId],
      );
    }
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "stopped", reason: "applied_changes_cap" });
    expect(await rows(pool, "select count(*)::int as count from chat_messages where paddle_id = $1 and card_type = 'action'", [gala.jamie])).toEqual([
      { count: 0 },
    ]);
  });

  it("skips a paddle without an authorized hold", async () => {
    const { gala, trigger } = await goldenExhausted();
    await pool.query("update holds set status = 'voided' where paddle_id = $1", [gala.jamie]);
    expect(await runGated(gala.jamie, gala.eventId, trigger)).toMatchObject({ outcome: "skipped", reason: "no_hold" });
  });

  it("records every gated run", async () => {
    const { gala, planId, trigger } = await goldenExhausted();
    await pool.query("update glim_plans set status = 'paused' where id = $1", [planId]);
    const report = await runGated(gala.jamie, gala.eventId, trigger);
    expect(await rows(pool, "select outcome, decided_by, error from glim_autopilot_runs where id = $1", [report.runId])).toEqual([
      { outcome: "skipped", decided_by: "none", error: "plan_not_active" },
    ]);
  });
});
