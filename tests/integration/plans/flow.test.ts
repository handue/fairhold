/**
 * The golden beat on Postgres (docs/planning/glim-autopilot.md §10, flow.test.ts): Jamie confirms
 * "$500. I really want the chef's dinner. Spa only under $120." with Wine Tasting hearted; a
 * rival's $360 is answered at $380 and a rival's $400 passes Glim's limit. The tick's own steps
 * (scan, claim, run) then move the money to Wine Tasting with the recorded decision, and every
 * record of it commits together.
 */
import { describe, expect, it } from "vitest";

import { getCommitments } from "@/server/engine";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";
import { loadGlimState } from "@/server/queries/glim-state";

import { getTestDatabase } from "../../helpers/database";

import { bid, createGala, heart, makeDue, recordedModel, rows, startBidding } from "./support";

const database = getTestDatabase();
const { pool } = database;

describe("the golden autopilot beat", () => {
  it("moves the money to Wine Tasting when the dinner gets away, and tells Jamie why", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    const { card, confirmed } = await startBidding(database, gala.jamie);
    expect(card.items.map((item) => [item.lotNumber, item.maxCents])).toEqual([
      [7, 38_000],
      [12, 12_000],
    ]);
    expect(card.backups.map((backup) => [backup.lotNumber, backup.source])).toEqual([[9, "heart"]]);
    expect(confirmed.mandate).toMatchObject({ budgetCents: 50_000, excludedLotIds: [] });

    // A rival's $360 is answered at $380, Jamie's limit; a rival's $400 passes it.
    const answered = await bid(pool, gala.rival, gala.lots.chef, 36_000);
    expect(answered.proxyBids.map((entry) => entry.amountCents)).toEqual([38_000]);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);

    expect(await scanFacts(pool)).toMatchObject({ triggers: 1 });
    await makeDue(pool, gala.jamie);
    const [claim, ...others] = await claimDue(pool, { limit: 4 });
    expect(others).toEqual([]);
    expect(claim?.reasons).toEqual([
      expect.objectContaining({ kind: "limit_exhausted", lotId: gala.lots.chef, lotNumber: 7, limitCents: 38_000, currentBidCents: 40_000 }),
    ]);
    if (!claim) return;

    const report = await runAutopilot(claim, { database, model: recordedModel });
    expect(report).toMatchObject({ outcome: "applied", decidedBy: "model" });
    expect(report.decision?.fixtureKey).toBe("autopilot:limit_exhausted:7:9");

    // Wine Tasting's limit at $380 with an opening bid of $220; Spa Day untouched.
    const limits = await rows<{ lot_id: string; max_cents: number; active: boolean }>(
      pool,
      "select lot_id, max_cents, active from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents",
      [gala.jamie],
    );
    expect(limits).toEqual([
      { lot_id: gala.lots.spa, max_cents: 12_000, active: true },
      { lot_id: gala.lots.wine, max_cents: 38_000, active: true },
    ]);
    const wineBids = await rows<{ amount_cents: number; source: string; glim_action_id: string | null }>(
      pool,
      "select amount_cents, source, glim_action_id from bids where lot_id = $1 and paddle_id = $2",
      [gala.lots.wine, gala.jamie],
    );
    expect(wineBids).toEqual([{ amount_cents: 22_000, source: "glim", glim_action_id: report.actionId }]);

    // Plan version 2 holds Spa Day $120 and Wine Tasting $380; Chef's Table left the plan.
    const plan = await rows<{ version: number; lot_id: string; max_cents: number }>(
      pool,
      `select p.version, i.lot_id, i.max_cents from glim_plans p join glim_plan_items i on i.plan_id = p.id
       where p.id = $1 order by i.max_cents`,
      [confirmed.planId],
    );
    expect(plan).toEqual([
      { version: 2, lot_id: gala.lots.spa, max_cents: 12_000 },
      { version: 2, lot_id: gala.lots.wine, max_cents: 38_000 },
    ]);

    // The action, the card, the run and the finished row.
    const [action] = await rows<{ kind: string; lot_id: string; amount_cents: number; chip: string; message: string; detail: { decidedBy: string; whySource: string; why: string } }>(
      pool,
      "select kind, lot_id, amount_cents, chip, message, detail from glim_actions where id = $1",
      [report.actionId],
    );
    expect(action).toMatchObject({
      kind: "autopilot_changed",
      lot_id: gala.lots.wine,
      amount_cents: 38_000,
      chip: "winning",
      message: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
      detail: { decidedBy: "model", whySource: "model" },
    });
    const [message] = await rows<{ role: string; card_type: string; card: Record<string, unknown>; tokens_used: number }>(
      pool,
      "select role, card_type, card, tokens_used from chat_messages where id = $1",
      [report.chatMessageId],
    );
    expect(message).toMatchObject({
      role: "glim",
      card_type: "action",
      tokens_used: 0,
      card: {
        type: "autopilot",
        actionId: report.actionId,
        triggerLine: null,
        whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
        whySource: "model",
        chip: { kind: "winning", amountCents: 22_000 },
        rulesLine: "Your rules: $500 in all · Spa Day up to $120",
        skip: { lotId: gala.lots.wine, label: "Skip Wine Tasting" },
      },
    });
    expect(String(message?.card.whyLine)).toBe(action?.detail.why);
    expect(String(message?.card.eyebrow)).toMatch(/^\d{1,2}:\d{2} [AP]M · CHEF’S TABLE → WINE TASTING$/);
    const [run] = await rows<{ outcome: string; decided_by: string; action_id: string; plan_version_before: number; plan_version_after: number; model: string }>(
      pool,
      "select outcome, decided_by, action_id, plan_version_before, plan_version_after, model from glim_autopilot_runs where id = $1",
      [report.runId],
    );
    expect(run).toEqual({ outcome: "applied", decided_by: "model", action_id: report.actionId, plan_version_before: 1, plan_version_after: 2, model: "recorded" });
    const finished = await rows<{ payload: Record<string, unknown> }>(
      pool,
      "select payload from event_log where paddle_id = $1 and type = 'glim' and payload->>'kind' like 'autopilot_%' order by id",
      [gala.jamie],
    );
    expect(finished.map((row) => row.payload.kind)).toEqual(["autopilot_deciding", "autopilot_finished"]);
    expect(finished[1]?.payload).toMatchObject({ runId: report.runId, outcome: "applied", chatMessageId: report.chatMessageId, actionId: report.actionId });

    // Within the $500 Jamie named: $120 on Spa Day and $380 on Wine Tasting.
    const spend = (await getCommitments([gala.jamie], pool))
      .filter((row) => [gala.lots.chef, gala.lots.wine, gala.lots.spa].includes(row.lotId))
      .reduce((sum, row) => sum + row.cents, 0);
    expect(spend).toBe(50_000);

    // Glim's chat now knows what it did, with the amounts it may repeat.
    const state = await loadGlimState({ paddleId: gala.jamie }, database);
    expect(state?.recentDecisions).toEqual([
      expect.objectContaining({ message: action?.message, amountsCents: expect.arrayContaining([38_000, 22_000]) }),
    ]);

    // Its own writes never wake Glim again.
    expect(await scanFacts(pool)).toMatchObject({ triggers: 0 });
    await makeDue(pool, gala.jamie);
    expect(await claimDue(pool, { limit: 4 })).toEqual([]);
  });

  it("decides by the rule, with the same move, when the model has nothing recorded", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("no claim");
    const empty = (await import("@/server/glim/recorded")).createRecordedGlimModel({ recordings: [] });
    const report = await runAutopilot(claim, { database, model: empty });
    expect(report).toMatchObject({ outcome: "applied", decidedBy: "rule" });
    const [action] = await rows<{ message: string; detail: { whySource: string; why: string } }>(
      pool,
      "select message, detail from glim_actions where id = $1",
      [report.actionId],
    );
    expect(action).toMatchObject({ detail: { whySource: "template", why: "It’s a lot you hearted." } });
  });
});

describe("the autopilot tick task", () => {
  it("scans, claims and runs without making the tick wait for the decision", async () => {
    const { createAutopilotTickTask } = await import("@/server/plans/task");
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowModel = {
      mode: "recorded" as const,
      async respond(...args: Parameters<typeof recordedModel.respond>) {
        await gate;
        return recordedModel.respond(...args);
      },
    };
    const task = createAutopilotTickTask({ database, model: slowModel });
    await task.run();
    await makeDue(pool, gala.jamie);
    // The round returns while the model is still deciding.
    await task.run();
    const [running] = await rows<{ running: boolean }>(pool, "select running_since is not null as running from glim_autopilot where paddle_id = $1", [
      gala.jamie,
    ]);
    expect(running?.running).toBe(true);
    release();
    await task.idle();
    expect(await rows(pool, "select outcome, decided_by from glim_autopilot_runs where paddle_id = $1", [gala.jamie])).toEqual([
      { outcome: "applied", decided_by: "model" },
    ]);
    expect(await rows(pool, "select running_since, claimed_reasons from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([
      { running_since: null, claimed_reasons: [] },
    ]);
  });
});

describe("a run that fails", () => {
  it("leaves a failed run row and ends Deciding, and its reasons come back until the third failure", { timeout: 30_000 }, async () => {
    const { requeueClaim } = await import("@/server/plans/scan");
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    const { confirmed } = await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("not due");

    // Another transaction holds the plan row past the apply's 5 s lock timeout. NO KEY UPDATE
    // blocks the apply's FOR UPDATE, but not the foreign-key check of the failed run's row.
    const blocker = await pool.connect();
    try {
      await blocker.query("begin");
      await blocker.query("select id from glim_plans where id = $1 for no key update", [confirmed.planId]);
      await expect(runAutopilot(claim, { database, model: recordedModel })).rejects.toThrow(/lock timeout/);
    } finally {
      await blocker.query("rollback");
      blocker.release();
    }
    const [run] = await rows<{ outcome: string; error: string }>(pool, "select outcome, error from glim_autopilot_runs where paddle_id = $1", [gala.jamie]);
    expect(run?.outcome).toBe("failed");
    expect(run?.error).toMatch(/lock timeout/);
    const kinds = await rows<{ kind: string; outcome: string | null }>(
      pool,
      "select payload->>'kind' as kind, payload->>'outcome' as outcome from event_log where paddle_id = $1 and payload->>'kind' like 'autopilot_%' order by id",
      [gala.jamie],
    );
    expect(kinds).toEqual([
      { kind: "autopilot_deciding", outcome: null },
      { kind: "autopilot_finished", outcome: "failed" },
    ]);

    // The task puts the reasons back; after the third failure they are dropped to error_log.
    let current = claim;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await requeueClaim(pool, current, { delayMs: 0, countAttempt: true, error: new Error("boom") });
      const [state] = await rows<{ reasons: unknown[]; attempts: number }>(pool, "select reasons, attempts from glim_autopilot where paddle_id = $1", [gala.jamie]);
      if (attempt < 3) {
        expect(state).toMatchObject({ attempts: attempt, reasons: [expect.objectContaining({ kind: "limit_exhausted" })] });
        const [again] = await claimDue(pool, { limit: 4 });
        if (!again) throw new Error("not reclaimed");
        current = again;
      } else {
        expect(state).toMatchObject({ attempts: 0, reasons: [] });
      }
    }
    expect(await rows(pool, "select code from error_log where paddle_id = $1", [gala.jamie])).toEqual([{ code: "autopilot_run_failed" }]);
  });

  it("never fails once its change committed: a release lost twice is logged and left to the lease (review)", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("not due");

    // releaseClaim is the only statement that sets last_run_at; it fails both times here.
    let lost = 0;
    const query = (text: unknown, values?: unknown) => {
      if (typeof text === "string" && text.includes("last_run_at = now()")) {
        lost += 1;
        return Promise.reject(Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }));
      }
      return (pool.query as (text: unknown, values?: unknown) => Promise<unknown>)(text, values);
    };
    const flaky = new Proxy(pool, {
      get(target, property) {
        if (property === "query") return query;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const errors: string[] = [];
    const report = await runAutopilot(claim, {
      database: { ...database, pool: flaky },
      model: recordedModel,
      onError: (_error, context) => errors.push(context),
    });

    expect(report).toMatchObject({ outcome: "applied", decidedBy: "model" });
    expect(lost).toBe(2);
    expect(errors).toHaveLength(2);
    expect(await rows(pool, "select outcome from glim_autopilot_runs where paddle_id = $1", [gala.jamie])).toEqual([{ outcome: "applied" }]);
    expect(
      await rows(pool, "select payload->>'outcome' as outcome from event_log where paddle_id = $1 and payload->>'kind' = 'autopilot_finished'", [gala.jamie]),
    ).toEqual([{ outcome: "applied" }]);
    expect(await rows(pool, "select code from error_log where paddle_id = $1", [gala.jamie])).toEqual([{ code: "autopilot_release_failed" }]);
    // Nothing was put back as a failure: the claim still holds its lease and reasons.
    const [held] = await rows<{ reasons: unknown[]; claimed: unknown[]; attempts: number }>(
      pool,
      "select reasons, claimed_reasons as claimed, attempts from glim_autopilot where paddle_id = $1",
      [gala.jamie],
    );
    expect(held).toMatchObject({ reasons: [], claimed: [expect.objectContaining({ kind: "limit_exhausted" })], attempts: 0 });

    // Once the lease expires the fact is read again; the plan version moved, so nothing applies twice.
    await pool.query("update glim_autopilot set running_since = now() - interval '61 seconds' where paddle_id = $1", [gala.jamie]);
    const [again] = await claimDue(pool, { limit: 4 });
    if (!again) throw new Error("lease not taken over");
    expect(await runAutopilot(again, { database, model: recordedModel })).toMatchObject({ outcome: "skipped", decidedBy: "none" });
    expect(await rows(pool, "select count(*)::int as count from glim_actions where paddle_id = $1 and kind = 'autopilot_changed'", [gala.jamie])).toEqual([
      { count: 1 },
    ]);
    expect(await rows(pool, "select running_since, claimed_reasons from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([
      { running_since: null, claimed_reasons: [] },
    ]);
  });
});
