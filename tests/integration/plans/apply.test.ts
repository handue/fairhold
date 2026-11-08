/**
 * The one writer of Glim plans on Postgres (docs/planning/glim-autopilot.md §5.2): one
 * transaction for the engine change and its records, the fences under the lot locks, the
 * after-check of the named budget, races against closing and other paddles' limits, the
 * deadlock retry, and the guest's confirmPlan and skipLot.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";
import { describe, expect, it } from "vitest";

import { closeEvent, createLimits, getBiddingPower, placeBid, setMaxBid } from "@/server/engine";
import type { AutopilotChange, AutopilotDecisionLot, PricedLot } from "@/server/glim/autopilot/types";
import { buildChange, checkDecision, liveGlimLimits } from "@/server/glim/autopilot/validate";
import { parseMandate } from "@/server/glim/mandate";
import { applyAutopilotChange, confirmPlan, skipLot, spendOnMandate, type ApplyAutopilotInput } from "@/server/plans/apply";
import { loadAutopilotRead } from "@/server/plans/context";
import { planCardSchema } from "@/server/plans/proposals";

import { getTestDatabase } from "../../helpers/database";
import { modelReply, scriptedModel, toolUseBlock } from "../../unit/glim/helpers";
import { createLot } from "../engine/support/fixtures";

import { bid, createGala, heart, propose, rows, startBidding, type Gala } from "./support";

const database = getTestDatabase();
const { pool } = database;

/** The golden beat up to the rival's $400, read as the run would read it. */
async function exhausted(options: Parameters<typeof createGala>[1] = {}) {
  const gala = await createGala(pool, options);
  await heart(pool, gala.jamie, gala.lots.wine);
  const { confirmed } = await startBidding(database, gala.jamie);
  await bid(pool, gala.rival, gala.lots.chef, 40_000);
  const read = await loadAutopilotRead(gala.jamie, [], database);
  if (!read?.context) throw new Error("no context");
  return { gala, planId: confirmed.planId, context: read.context };
}

function changeOf(context: NonNullable<Awaited<ReturnType<typeof loadAutopilotRead>>>["context"], lots: AutopilotDecisionLot[]): AutopilotChange {
  if (!context) throw new Error("no context");
  const check = checkDecision({ action: "change", lots, raiseToCents: null, reason: "money_freed", why: "" }, context);
  if (check.action !== "change") throw new Error(`expected a change, got ${check.action}`);
  return check.change;
}

const GOLDEN: AutopilotDecisionLot[] = [
  { lotNumber: 12, priority: 2, maxCents: null },
  { lotNumber: 9, priority: 3, maxCents: null },
];

/** A change straight to the writer, past the validator: the raw maxima as given. */
function rawChange(context: NonNullable<Awaited<ReturnType<typeof loadAutopilotRead>>>["context"], after: { lotId: string; lotNumber: number; maxCents: number }[]) {
  if (!context) throw new Error("no context");
  const priced: PricedLot[] = after.map((lot) => ({ ...lot, shortTitle: "", priority: 1, capCents: null, floorCents: 0 }));
  return buildChange(priced, liveGlimLimits(context));
}

function input(gala: Gala, planId: string, change: AutopilotChange, fields: Partial<ApplyAutopilotInput> = {}): ApplyAutopilotInput {
  const runId = randomUUID();
  return {
    runId,
    paddleId: gala.jamie,
    eventId: gala.eventId,
    planId,
    planVersion: 1,
    change,
    describe: (_applied, ids) => ({
      action: { lotId: null, amountCents: null, limitCents: null, chip: "none", message: "test change", detail: { runId } },
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
    ...fields,
  };
}

async function snapshot(gala: Gala) {
  const [limits, items, actions, messages, runs, log, plans] = await Promise.all([
    rows(pool, "select lot_id, max_cents, active, owner from bid_limits where paddle_id = $1 order by lot_id, created_at", [gala.jamie]),
    rows(pool, "select i.lot_id, i.max_cents, i.priority from glim_plan_items i join glim_plans p on p.id = i.plan_id where p.paddle_id = $1 order by i.lot_id", [gala.jamie]),
    rows(pool, "select kind, message from glim_actions where paddle_id = $1 order by created_at", [gala.jamie]),
    rows(pool, "select role, card_type from chat_messages where paddle_id = $1 order by created_at", [gala.jamie]),
    rows(pool, "select outcome from glim_autopilot_runs where paddle_id = $1", [gala.jamie]),
    rows(pool, "select id from event_log where event_id = $1 order by id", [gala.eventId]),
    rows(pool, "select status, version from glim_plans where paddle_id = $1 order by created_at", [gala.jamie]),
  ]);
  return { limits, items, actions, messages, runs, log, plans };
}

describe("applyAutopilotChange", () => {
  it("applies the golden change and its records in one transaction", async () => {
    const { gala, planId, context } = await exhausted();
    const result = await applyAutopilotChange(input(gala, planId, changeOf(context, GOLDEN)));
    expect(result).toMatchObject({ outcome: "applied", planVersion: 2 });
    expect(await rows(pool, "select version from glim_plans where id = $1", [planId])).toEqual([{ version: 2 }]);
  });

  it("leaves no limit, item, action, card, run or log row when anything after the engine fails", async () => {
    const { gala, planId, context } = await exhausted();
    const before = await snapshot(gala);
    const failing = input(gala, planId, changeOf(context, GOLDEN), {
      describe: () => {
        throw new Error("injected after createLimits");
      },
    });
    await expect(applyAutopilotChange(failing)).rejects.toThrow("injected after createLimits");
    expect(await snapshot(gala)).toEqual(before);
  });

  it("is stale when the plan version moved, the plan is paused or replaced", async () => {
    const { gala, planId, context } = await exhausted();
    const change = changeOf(context, GOLDEN);
    expect(await applyAutopilotChange(input(gala, planId, change, { planVersion: 2 }))).toEqual({ outcome: "stale", reason: "plan_version" });
    expect(await applyAutopilotChange(input(gala, randomUUID(), change))).toEqual({ outcome: "stale", reason: "plan_replaced" });
    await pool.query("update glim_plans set status = 'paused' where id = $1", [planId]);
    expect(await applyAutopilotChange(input(gala, planId, change))).toEqual({ outcome: "stale", reason: "plan_paused" });
  });

  it("is stale when the guest set their own max on a target lot after the read", async () => {
    const { gala, planId, context } = await exhausted();
    const change = changeOf(context, GOLDEN);
    expect((await setMaxBid(gala.jamie, gala.lots.wine, 25_000, { pool })).ok).toBe(true);
    const before = await snapshot(gala);
    expect(await applyAutopilotChange(input(gala, planId, change))).toEqual({ outcome: "stale", reason: "guest_max" });
    expect(await snapshot(gala)).toEqual(before);
  });

  it("is stale while a plan card is waiting for the guest", async () => {
    const { gala, planId, context } = await exhausted();
    const change = changeOf(context, GOLDEN);
    // Glim just showed a new plan card ("don't bid on the wine tasting", say) that is not confirmed yet.
    await pool.query("insert into glim_plans (paddle_id, status, budget_cents, proposal) values ($1, 'proposed', 50000, '{}'::jsonb)", [gala.jamie]);
    expect(await applyAutopilotChange(input(gala, planId, change))).toEqual({ outcome: "stale", reason: "pending_card" });
  });

  it("refuses a raw change over the named budget in the after-check, and logs it", async () => {
    // $1,000 held, $500 named: the engine allows $520 on the guest's lots; the mandate does not.
    const { gala, planId, context } = await exhausted({ holdCents: 100_000 });
    const before = await snapshot(gala);
    const change = rawChange(context, [
      { lotId: gala.lots.spa, lotNumber: 12, maxCents: 12_000 },
      { lotId: gala.lots.wine, lotNumber: 9, maxCents: 40_000 },
    ]);
    expect(await applyAutopilotChange(input(gala, planId, change))).toMatchObject({ outcome: "refused", reason: "over_budget" });
    expect(await snapshot(gala)).toEqual(before);
    expect(await rows(pool, "select source, code from error_log where paddle_id = $1", [gala.jamie])).toEqual([
      { source: "glim", code: "autopilot_after_check" },
    ]);
  });

  it("refuses a raw change outside the mandate under the locks, as a validator bug", async () => {
    const { gala, planId, context } = await exhausted();
    const cabin = await createLot(pool, gala.eventId, { number: 3, startingBidCents: 5_000, minRaiseCents: 1_000 });
    const change = rawChange(context, [
      { lotId: gala.lots.spa, lotNumber: 12, maxCents: 12_000 },
      { lotId: cabin, lotNumber: 3, maxCents: 10_000 },
    ]);
    const result = await applyAutopilotChange(input(gala, planId, change));
    expect(result).toMatchObject({ outcome: "refused", reason: "mandate_violation" });
    if (result.outcome === "refused") expect(result.issues.map((issue) => issue.reason)).toEqual(["outside_mandate"]);
    expect(await rows(pool, "select code from error_log where paddle_id = $1", [gala.jamie])).toEqual([{ code: "autopilot_validator_bug" }]);
  });

  it("refuses with nothing written when the engine refuses", async () => {
    const { gala, planId, context } = await exhausted();
    const before = await snapshot(gala);
    const change = rawChange(context, [
      { lotId: gala.lots.spa, lotNumber: 12, maxCents: 12_000 },
      { lotId: gala.lots.wine, lotNumber: 9, maxCents: 21_500 },
    ]);
    expect(await applyAutopilotChange(input(gala, planId, change))).toMatchObject({
      outcome: "refused",
      reason: "below_minimum",
      refusal: { reason: "below_minimum", minimumCents: 22_000 },
    });
    expect(await snapshot(gala)).toEqual(before);
  });

  it("lets a change that only lowers or drops pass while the guest's own bids are over the budget", async () => {
    const { gala, planId } = await exhausted({ holdCents: 100_000 });
    // Jamie's own $450 on Wine Tasting, a backup in the mandate: $570 is now on the guest's lots.
    expect((await placeBid(gala.jamie, gala.lots.wine, 45_000, "guest", { pool })).ok).toBe(true);
    const read = await loadAutopilotRead(gala.jamie, [], database);
    const mandate = parseMandate((await rows<{ mandate: unknown }>(pool, "select mandate from glim_plans where id = $1", [planId]))[0]?.mandate);
    if (!read?.context || !mandate) throw new Error("no context");
    const client = await pool.connect();
    try {
      expect(await spendOnMandate(client, gala.jamie, mandate)).toBe(57_000);
    } finally {
      client.release();
    }
    const lower = changeOf(read.context, [{ lotNumber: 12, priority: 2, maxCents: 10_000 }]);
    expect(lower.lowerOrDropOnly).toBe(true);
    expect(await applyAutopilotChange(input(gala, planId, lower))).toMatchObject({ outcome: "applied" });
    expect(await rows(pool, "select max_cents from bid_limits where paddle_id = $1 and lot_id = $2 and active", [gala.jamie, gala.lots.spa])).toEqual([
      { max_cents: 10_000 },
    ]);
  });

  it("retries the whole transaction after a deadlock", async () => {
    const { gala, planId, context } = await exhausted();
    let injected = 0;
    const flaky = {
      async connect() {
        const client = await pool.connect();
        const original = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
        const patched = (text: string, values?: unknown[]) => {
          if (injected === 0 && typeof text === "string" && text.includes("update glim_plans set version")) {
            injected += 1;
            return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
          }
          return original(text, values);
        };
        Object.assign(client, { query: patched });
        const release = client.release.bind(client);
        Object.assign(client, {
          release: (destroy?: boolean) => {
            Object.assign(client, { query: original, release });
            release(destroy);
          },
        });
        return client;
      },
    } as unknown as pg.Pool;
    expect(await applyAutopilotChange(input(gala, planId, changeOf(context, GOLDEN), { pool: flaky }))).toMatchObject({ outcome: "applied" });
    expect(injected).toBe(1);
    expect(await rows(pool, "select count(*)::int as count from glim_actions where paddle_id = $1 and kind = 'autopilot_changed'", [gala.jamie])).toEqual([
      { count: 1 },
    ]);
    expect(await rows(pool, "select count(*)::int as count from bid_limits where paddle_id = $1 and lot_id = $2", [gala.jamie, gala.lots.wine])).toEqual([
      { count: 1 },
    ]);
  });

  it("never deadlocks against closeEvent or another paddle's limits on the same lots, over 50 waves", { timeout: 120_000 }, async () => {
    const outcomes: string[] = [];
    for (let wave = 0; wave < 50; wave += 1) {
      const { gala, planId, context } = await exhausted();
      const change = changeOf(context, GOLDEN);
      const rival = wave % 2 === 0
        ? closeEvent(gala.eventId, { pool }).then(() => "closed")
        : createLimits(gala.other, [
            { lotId: gala.lots.wine, maxCents: 30_000 + wave * 100 },
            { lotId: gala.lots.spa, maxCents: 11_000 },
          ], { pool, owner: "guest_max" }).then((result) => (result.ok ? "rival_limits" : result.refusal.reason));
      const [applied, other] = await Promise.all([applyAutopilotChange(input(gala, planId, change)), rival]);
      outcomes.push(`${applied.outcome}/${other}`);
      const power = await getBiddingPower([gala.jamie, gala.rival, gala.other], pool);
      for (const entry of power.values()) expect(entry.committedCents).toBeLessThanOrEqual(entry.holdCents);
    }
    // Every wave finished; which side won the race varies.
    expect(outcomes).toHaveLength(50);
    expect(outcomes.every((outcome) => /^(applied|refused)\//.test(outcome))).toBe(true);
  });
});

describe("confirmPlan", () => {
  it("supersedes the running plan and merges a change card into its mandate", async () => {
    const gala = await createGala(pool);
    const first = await startBidding(database, gala.jamie);
    const { planId: changeId } = await propose(database, gala.jamie);
    await pool.query(
      `update glim_plans set proposal = jsonb_set(jsonb_set(proposal, '{card,tool}', '"propose_change"'), '{card,namedBudgetCents}', 'null')
       where id = $1`,
      [changeId],
    );
    const confirmed = await confirmPlan({ paddleId: gala.jamie, proposedPlanId: changeId, pool });
    expect(confirmed).toMatchObject({ ok: true, planId: changeId });
    if (!confirmed.ok) return;
    // A null budget on a change card keeps the $500 named before.
    expect(confirmed.mandate?.budgetCents).toBe(50_000);
    expect(await rows(pool, "select id, status from glim_plans where paddle_id = $1 order by created_at", [gala.jamie])).toEqual([
      { id: first.confirmed.planId, status: "superseded" },
      { id: changeId, status: "active" },
    ]);
    expect(await rows(pool, "select cursor_event_log_id::text as cursor from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([
      { cursor: (await rows<{ id: string }>(pool, "select max(id)::text as id from event_log where paddle_id = $1", [gala.jamie]))[0]?.id },
    ]);
  });

  it("lowers B to a change card's budget when the guest names none, as the card stated (review)", async () => {
    const gala = await createGala(pool);
    await startBidding(database, gala.jamie);
    const change = scriptedModel(() =>
      modelReply([
        toolUseBlock("propose_change", {
          budget_dollars: null,
          items: [{ lot_number: 12, priority: 1, cap_dollars: 120 }],
          backup_lot_numbers: [],
          excluded_lot_numbers: [],
        }),
      ]),
    );
    const { planId, card } = await propose(database, gala.jamie, { guestText: "Keep only the spa, at $120.", model: change.model });
    // The running plan's B is $500; this card's maxima total $120, and its rules line says so.
    expect(card).toMatchObject({ kind: "change", namedBudgetCents: null, budgetCents: 12_000, mandateBudgetCents: 12_000 });
    const confirmed = await confirmPlan({ paddleId: gala.jamie, proposedPlanId: planId, pool });
    expect(confirmed).toMatchObject({ ok: true, mandate: { budgetCents: 12_000 } });
    // A card stored before mandateBudgetCents existed reads as stating its named budget.
    const older = Object.fromEntries(Object.entries(card).filter(([key]) => key !== "mandateBudgetCents"));
    expect(planCardSchema.parse({ ...older, namedBudgetCents: 50_000 }).mandateBudgetCents).toBe(50_000);
  });

  it("refuses a card whose maxima no longer fit, and writes nothing", async () => {
    const gala = await createGala(pool);
    const { planId } = await propose(database, gala.jamie);
    // A rival passes the card's $120 on Spa Day before Start bidding.
    await bid(pool, gala.rival, gala.lots.spa, 15_000);
    const result = await confirmPlan({ paddleId: gala.jamie, proposedPlanId: planId, pool });
    expect(result).toMatchObject({ ok: false, reason: "refused", refusal: { reason: "below_minimum" } });
    expect(await rows(pool, "select status, mandate from glim_plans where id = $1", [planId])).toEqual([{ status: "proposed", mandate: null }]);
    expect(await rows(pool, "select 1 from bid_limits where paddle_id = $1", [gala.jamie])).toEqual([]);
    expect(await rows(pool, "select 1 from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([]);
  });

  it("arms nothing for a card shown with autopilot off, and refuses a plan that is not proposed", async () => {
    const gala = await createGala(pool);
    const { planId } = await propose(database, gala.jamie);
    await pool.query("update glim_plans set proposal = jsonb_set(proposal, '{card,autopilot}', 'false') where id = $1", [planId]);
    const result = await confirmPlan({ paddleId: gala.jamie, proposedPlanId: planId, pool });
    expect(result).toMatchObject({ ok: true, mandate: null });
    expect(await rows(pool, "select 1 from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([]);
    expect(await confirmPlan({ paddleId: gala.jamie, proposedPlanId: planId, pool })).toEqual({ ok: false, reason: "not_proposed" });
  });
});

describe("skipLot", () => {
  it("ends Glim's limit, keeps the bid, rules the lot out and turns a decision in flight stale", async () => {
    const { gala, planId, context } = await exhausted();
    const golden = changeOf(context, GOLDEN);
    expect(await applyAutopilotChange(input(gala, planId, golden))).toMatchObject({ outcome: "applied" });
    const skipped = await skipLot({ paddleId: gala.jamie, lotId: gala.lots.wine, pool });
    expect(skipped).toMatchObject({ ok: true, removed: true, planVersion: 3 });
    expect(await rows(pool, "select 1 from bid_limits where paddle_id = $1 and lot_id = $2 and active", [gala.jamie, gala.lots.wine])).toEqual([]);
    expect(await rows(pool, "select high_paddle_id, current_bid_cents from lots where id = $1", [gala.lots.wine])).toEqual([
      { high_paddle_id: gala.jamie, current_bid_cents: 22_000 },
    ]);
    const [plan] = await rows<{ mandate: { excludedLotIds: string[] } }>(pool, "select mandate from glim_plans where id = $1", [planId]);
    expect(plan?.mandate.excludedLotIds).toEqual([gala.lots.wine]);
    expect(await rows(pool, "select message from glim_actions where id = $1", [skipped.ok ? skipped.actionId : ""])).toEqual([
      { message: "I stopped bidding on Wine Tasting. Your $220 bid stands." },
    ]);
    // A decision read before the skip can no longer apply.
    expect(await applyAutopilotChange(input(gala, planId, golden, { planVersion: 2 }))).toEqual({ outcome: "stale", reason: "plan_version" });
    // And autopilot never adds Wine Tasting back.
    const read = await loadAutopilotRead(gala.jamie, [], database);
    const check = read?.context
      ? checkDecision({ action: "change", lots: GOLDEN, raiseToCents: null, reason: "money_freed", why: "" }, read.context)
      : null;
    expect(check).toMatchObject({ ok: false, issues: [expect.objectContaining({ reason: "excluded_lot" })] });
  });
});
