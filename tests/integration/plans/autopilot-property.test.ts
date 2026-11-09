import { randomUUID } from "node:crypto";

import fc from "fast-check";
import pg from "pg";
import { afterAll, describe, it } from "vitest";

import { createLimits, pauseLimits, placeBid, resumeLimits, setMaxBid } from "@/server/engine";
import { commitmentCents } from "@/server/engine/rules";
import { allocatePlan, type PlanLot } from "@/server/glim/allocator";
import type { AutopilotChange, AutopilotDecisionLot, PricedLot } from "@/server/glim/autopilot/types";
import { buildChange, checkDecision, liveGlimLimits } from "@/server/glim/autopilot/validate";
import type { GlimMandate } from "@/server/glim/mandate";
import { applyAutopilotChange, type ApplyAutopilotInput } from "@/server/plans/apply";
import { loadAutopilotRead } from "@/server/plans/context";

import { getTestDatabase } from "../../helpers/database";
import { invariantViolations, propertyRuns, worldConfigArbitrary, type AuctionView, type WorldConfig } from "../../unit/engine/support/auction-model";
import { createPgWorld } from "../engine/support/pg-world";

/*
 * The last line of enforcement on its own (docs/planning/glim-autopilot.md §10): raw changes go
 * straight to applyAutopilotChange, past the validator, next to validated decisions; waves run a
 * raw change, a guest bid, a rival bid and a pause or resume at once. Split changes hand the
 * engine limits (`set`, `removeLotIds`) drawn apart from the plan they claim (`after`), so the
 * writer is checked on what it writes, not on what buildChange would make. After every step:
 *   P1 the engine's invariants hold;
 *   P2 the guest's commitments on the mandate's lots never rise while above the named budget,
 *      and never rise above it (only autopilot can raise them here: the guest bids outside the
 *      mandate, and its own max inside it is set before the plan);
 *   P3 every Glim limit of the guest is on a mandate lot that is not excluded and was never
 *      under the guest's own max since the confirm;
 *   P4 every Glim limit of the guest is within the guest's cap;
 *   P5 the guest's own max only ever ends because it was outbid or its lot closed;
 *   P8 holds never change.
 * Default 50 runs (FAST_CHECK_RUNS / 20).
 *
 * Mutation checks, run once on Nov 7, 2026: with the after-check removed from
 * applyAutopilotChange, P2 failed (a raw change put the guest over the named budget); with the
 * mandate rules run on `after` only and the consistency check removed, P3 or P4 failed on a split
 * change (a limit outside the mandate, or above the guest's cap).
 */

const { url } = getTestDatabase();
const pool = new pg.Pool({ connectionString: url, max: 8, options: "-c synchronous_commit=off" });
pool.on("error", () => {});

afterAll(async () => {
  await pool.end();
});

const GUEST = 0;

interface Spec {
  budgetDollars: number | null;
  planLots: { lot: number; priority: number; capDollars: number | null }[];
  backupLots: number[];
  excludedLots: number[];
  /** A backup lot the guest put their own max on before confirming. */
  guestMaxLot: number | null;
}

type RawLot = { lot: number; maxDollars: number };
type Op =
  | { kind: "raw"; lots: RawLot[] }
  | { kind: "split"; after: RawLot[]; set: RawLot[]; remove: number[] }
  | { kind: "decision"; lots: { lot: number; priority: number; maxDollars: number | null }[] }
  | { kind: "guestBid"; lot: number; raises: number }
  | { kind: "rivalBid"; paddle: number; lot: number; raises: number }
  | { kind: "pause" }
  | { kind: "resume" };
type Step = { kind: "wave"; ops: Op[] } | Op;

function specArbitrary(config: WorldConfig): fc.Arbitrary<Spec> {
  const count = config.lots.length;
  return fc
    .record({
      order: fc.shuffledSubarray(
        Array.from({ length: count }, (_, index) => index),
        { minLength: count, maxLength: count },
      ),
      planCount: fc.integer({ min: 1, max: Math.max(1, count - 1) }),
      backupCount: fc.nat({ max: count }),
      budgetDollars: fc.option(fc.integer({ min: 20, max: 500 }), { nil: null, freq: 5 }),
      caps: fc.array(fc.option(fc.integer({ min: 10, max: 300 }), { nil: null, freq: 2 }), { minLength: count, maxLength: count }),
      priorities: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: count, maxLength: count }),
      guestMax: fc.boolean(),
    })
    .map(({ order, planCount, backupCount, budgetDollars, caps, priorities, guestMax }) => {
      const planned = order.slice(0, planCount);
      const rest = order.slice(planCount);
      const backups = rest.slice(0, Math.min(backupCount, rest.length));
      return {
        budgetDollars,
        planLots: planned.map((lot) => ({ lot, priority: priorities[lot] ?? 1, capDollars: caps[lot] ?? null })),
        backupLots: backups,
        excludedLots: rest.slice(backups.length),
        guestMaxLot: guestMax ? (backups[0] ?? null) : null,
      };
    });
}

function opArbitrary(config: WorldConfig): fc.Arbitrary<Op> {
  const lot = fc.nat({ max: config.lots.length - 1 });
  const rival = fc.integer({ min: 1, max: config.holds.length - 1 });
  const rawLots = fc.uniqueArray(fc.record({ lot, maxDollars: fc.integer({ min: 5, max: 900 }) }), {
    maxLength: config.lots.length,
    selector: (entry) => entry.lot,
  });
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant("raw" as const), lots: rawLots }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("split" as const),
        after: rawLots,
        set: rawLots,
        remove: fc.uniqueArray(lot, { maxLength: config.lots.length }),
      }),
    },
    {
      weight: 3,
      arbitrary: fc.record({
        kind: fc.constant("decision" as const),
        lots: fc.uniqueArray(
          fc.record({ lot, priority: fc.integer({ min: 1, max: 5 }), maxDollars: fc.option(fc.integer({ min: 5, max: 900 }), { nil: null }) }),
          { maxLength: config.lots.length, selector: (entry) => entry.lot },
        ),
      }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("guestBid" as const), lot, raises: fc.integer({ min: 0, max: 4 }) }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("rivalBid" as const), paddle: rival, lot, raises: fc.integer({ min: 0, max: 6 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("pause" as const) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("resume" as const) }) },
  );
}

const scenarioArbitrary = worldConfigArbitrary
  .map((config) => ({ ...config, holds: config.holds.map((hold, index) => (index === GUEST ? 120_000 : (hold ?? 40_000))) }))
  .chain((config) =>
    fc.record({
      config: fc.constant(config),
      spec: specArbitrary(config),
      steps: fc.array(
        fc.oneof(
          { weight: 2, arbitrary: opArbitrary(config) as fc.Arbitrary<Step> },
          {
            weight: 1,
            arbitrary: fc.record({
              kind: fc.constant("wave" as const),
              ops: fc.tuple(
                fc.record({
                  kind: fc.constant("raw" as const),
                  lots: fc.uniqueArray(fc.record({ lot: fc.nat({ max: config.lots.length - 1 }), maxDollars: fc.integer({ min: 5, max: 900 }) }), {
                    minLength: 1,
                    maxLength: config.lots.length,
                    selector: (entry) => entry.lot,
                  }),
                }),
                fc.record({ kind: fc.constant("guestBid" as const), lot: fc.nat({ max: config.lots.length - 1 }), raises: fc.integer({ min: 0, max: 3 }) }),
                fc.record({
                  kind: fc.constant("rivalBid" as const),
                  paddle: fc.integer({ min: 1, max: config.holds.length - 1 }),
                  lot: fc.nat({ max: config.lots.length - 1 }),
                  raises: fc.integer({ min: 0, max: 4 }),
                }),
                fc.constantFrom({ kind: "pause" as const }, { kind: "resume" as const }),
              ),
            }) as fc.Arbitrary<Step>,
          },
        ),
        { minLength: 1, maxLength: 14 },
      ),
    }),
  );

interface Armed {
  world: Awaited<ReturnType<typeof createPgWorld>>;
  planId: string;
  mandate: GlimMandate;
  inMandate: Set<number>;
  confirmedAt: Date;
}

async function arm(config: WorldConfig, spec: Spec): Promise<Armed> {
  const world = await createPgWorld(pool, config);
  const guest = world.paddleIds[GUEST] ?? "";
  await pool.query("update paddles set is_simulated = false where id = $1", [guest]);
  const lotId = (index: number) => world.lotIds[index] ?? "";
  if (spec.guestMaxLot !== null) {
    const view = await world.view();
    const lot = view.lots[spec.guestMaxLot];
    if (lot) await setMaxBid(guest, lotId(spec.guestMaxLot), lot.startingBidCents, world.engine);
  }
  const planRank = Math.max(...spec.planLots.map((entry) => entry.priority));
  const confirmedAt = (await pool.query<{ now: Date }>("select clock_timestamp() as now")).rows[0]?.now ?? new Date();
  const mandate: GlimMandate = {
    v: 1,
    budgetCents: spec.budgetDollars === null ? null : spec.budgetDollars * 100,
    lots: [
      ...spec.planLots.map((entry) => ({
        lotId: lotId(entry.lot),
        lotNumber: entry.lot + 1,
        role: "plan" as const,
        source: "words" as const,
        rank: entry.priority,
        capCents: entry.capDollars === null ? null : entry.capDollars * 100,
      })),
      ...spec.backupLots.map((lot) => ({ lotId: lotId(lot), lotNumber: lot + 1, role: "backup" as const, source: "heart" as const, rank: planRank + 2, capCents: null })),
    ],
    excludedLotIds: spec.excludedLots.map(lotId),
    guestWords: [],
    confirmedAt: confirmedAt.toISOString(),
  };
  const { rows } = await pool.query<{ id: string }>(
    `insert into glim_plans (paddle_id, status, budget_cents, proposal, version, mandate, confirmed_at)
     values ($1, 'active', $2, '{}'::jsonb, 1, $3::jsonb, $4) returning id`,
    [guest, mandate.budgetCents ?? 0, JSON.stringify(mandate), confirmedAt],
  );
  const planId = rows[0]?.id ?? "";
  // The first plan, as a confirmed card would price it.
  const read = await loadAutopilotRead(guest, [], { pool, db: getTestDatabase().db });
  if (read?.context) {
    const planLots: PlanLot[] = spec.planLots.flatMap((entry) => {
      const lot = read.context?.state.lots.find((candidate) => candidate.id === lotId(entry.lot));
      return lot ? [{ lot, priority: entry.priority, capCents: entry.capDollars === null ? null : entry.capDollars * 100 }] : [];
    });
    const allocation = allocatePlan({ holdCents: read.holdCents ?? 0, budgetCents: mandate.budgetCents, commitments: read.context.state.commitments, planLots });
    const items = allocation.items.filter((item) => item.maxCents >= item.floorCents && item.maxCents > 0);
    if (items.length > 0 && items.reduce((sum, item) => sum + item.maxCents, 0) <= allocation.limitCents) {
      for (const item of items) {
        await pool.query("insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, $3, $4, 'watching')", [
          planId,
          item.lot.id,
          item.priority,
          item.maxCents,
        ]);
      }
      await createLimits(guest, items.map((item) => ({ lotId: item.lot.id, maxCents: item.maxCents })), { ...world.engine, owner: "glim" });
    }
  }
  return { world, planId, mandate, inMandate: new Set(mandate.lots.map((entry) => world.lotIds.indexOf(entry.lotId))), confirmedAt };
}

function applyInput(armed: Armed, change: AutopilotChange, version: number): ApplyAutopilotInput {
  const runId = randomUUID();
  const guest = armed.world.paddleIds[GUEST] ?? "";
  return {
    runId,
    paddleId: guest,
    eventId: armed.world.eventId,
    planId: armed.planId,
    planVersion: version,
    change,
    describe: (_applied, ids) => ({
      action: { lotId: null, amountCents: null, limitCents: null, chip: "none", message: "property", detail: { runId } },
      card: { type: "autopilot", actionId: ids.actionId },
    }),
    run: {
      id: runId,
      paddleId: guest,
      eventId: armed.world.eventId,
      planId: armed.planId,
      triggers: [],
      decidedBy: "rule",
      model: null,
      brief: null,
      error: null,
      decision: null,
      issues: null,
      planVersionBefore: version,
      latencyMs: null,
      usage: null,
      tokensUsed: 0,
      startedAt: new Date(),
    },
    pool,
  };
}

async function readContext(armed: Armed) {
  return loadAutopilotRead(armed.world.paddleIds[GUEST] ?? "", [], { pool, db: getTestDatabase().db });
}

async function runOp(armed: Armed, op: Op, before: AuctionView, read: Awaited<ReturnType<typeof readContext>>): Promise<string> {
  const { world } = armed;
  const guest = world.paddleIds[GUEST] ?? "";
  const lotAt = (index: number) => before.lots[index];
  const amount = (index: number, raises: number) => {
    const lot = lotAt(index);
    if (!lot) return 100;
    const minimum = lot.highPaddle === null || lot.currentBidCents === null ? lot.startingBidCents : lot.currentBidCents + lot.minRaiseCents;
    return minimum + raises * lot.minRaiseCents;
  };
  const priced = (lots: RawLot[]): PricedLot[] =>
    lots.map((entry) => ({
      lotId: world.lotIds[entry.lot] ?? "",
      lotNumber: entry.lot + 1,
      shortTitle: "",
      priority: 1,
      capCents: null,
      floorCents: 0,
      maxCents: entry.maxDollars * 100,
    }));
  switch (op.kind) {
    case "raw": {
      if (!read?.context || !read.plan) return "no_plan";
      const result = await applyAutopilotChange(applyInput(armed, buildChange(priced(op.lots), liveGlimLimits(read.context)), read.plan.version));
      return result.outcome;
    }
    case "split": {
      if (!read?.context || !read.plan) return "no_plan";
      const change = buildChange(priced(op.after), liveGlimLimits(read.context));
      const split: AutopilotChange = {
        ...change,
        set: priced(op.set).map((entry) => ({ lotId: entry.lotId, lotNumber: entry.lotNumber, maxCents: entry.maxCents })),
        removeLotIds: op.remove.map((index) => world.lotIds[index] ?? ""),
      };
      return (await applyAutopilotChange(applyInput(armed, split, read.plan.version))).outcome;
    }
    case "decision": {
      if (!read?.context || !read.plan) return "no_plan";
      const lots: AutopilotDecisionLot[] = op.lots.map((entry) => ({
        lotNumber: entry.lot + 1,
        priority: entry.priority,
        maxCents: entry.maxDollars === null ? null : entry.maxDollars * 100,
      }));
      const check = checkDecision({ action: "change", lots, raiseToCents: null, reason: "money_freed", why: "" }, read.context);
      if (check.action !== "change") return check.action;
      return (await applyAutopilotChange(applyInput(armed, check.change, read.plan.version))).outcome;
    }
    case "guestBid": {
      // The guest bids by hand only outside the mandate; inside it, only before the plan (P2).
      if (armed.inMandate.has(op.lot)) return "skipped";
      const placed = await placeBid(guest, world.lotIds[op.lot] ?? "", amount(op.lot, op.raises), "guest", world.engine);
      return placed.ok ? "ok" : placed.refusal.reason;
    }
    case "rivalBid": {
      const placed = await placeBid(world.paddleIds[op.paddle] ?? "", world.lotIds[op.lot] ?? "", amount(op.lot, op.raises), "guest", world.engine);
      return placed.ok ? "ok" : placed.refusal.reason;
    }
    case "pause":
    case "resume": {
      // Day 3's rule: the plan's status and version move first, in their own transaction.
      const status = op.kind === "pause" ? "paused" : "active";
      await pool.query("update glim_plans set status = $2, version = version + 1 where id = $1", [armed.planId, status]);
      if (op.kind === "pause") await pauseLimits(guest, world.engine);
      else await resumeLimits(guest, world.engine);
      return "ok";
    }
  }
}

function spend(view: AuctionView, armed: Armed): number {
  return view.lots.reduce((sum, lot, index) => {
    if (!armed.inMandate.has(index)) return sum;
    const limit = view.limits.find((entry) => entry.paddle === GUEST && entry.lot === index && entry.active);
    return (
      sum +
      commitmentCents(
        {
          status: lot.status,
          highPaddleId: lot.highPaddle === null ? null : String(lot.highPaddle),
          currentBidCents: lot.currentBidCents,
          winningPaddleId: lot.winningPaddle === null ? null : String(lot.winningPaddle),
          winningCents: lot.winningCents,
        },
        String(GUEST),
        limit?.maxCents ?? null,
      )
    );
  }, 0);
}

async function check(armed: Armed, before: AuctionView, after: AuctionView, initialHolds: AuctionView["holds"], fail: (problem: string) => never) {
  const problems = invariantViolations(after);
  if (problems.length > 0) fail(`P1: ${problems.join("; ")}`);
  const budget = armed.mandate.budgetCents;
  const spent = spend(after, armed);
  if (budget !== null && spent > budget && spent > spend(before, armed)) fail(`P2: ${spent} on the mandate's lots, over the ${budget} budget`);
  const guestMaxLots = await pool.query<{ lot_id: string }>(
    "select lot_id from bid_limits where paddle_id = $1 and owner = 'guest_max' and created_at >= $2",
    [armed.world.paddleIds[GUEST], armed.confirmedAt],
  );
  const controlled = new Set(guestMaxLots.rows.map((row) => armed.world.lotIds.indexOf(row.lot_id)));
  const excluded = new Set(armed.mandate.excludedLotIds.map((lotId) => armed.world.lotIds.indexOf(lotId)));
  for (const limit of after.limits) {
    if (limit.paddle !== GUEST || limit.owner !== "glim" || !limit.active) continue;
    if (!armed.inMandate.has(limit.lot) || excluded.has(limit.lot) || controlled.has(limit.lot)) {
      fail(`P3: a Glim limit on lot ${limit.lot + 1}, which autopilot may not use`);
    }
    const cap = armed.mandate.lots.find((entry) => armed.world.lotIds.indexOf(entry.lotId) === limit.lot)?.capCents ?? null;
    if (cap !== null && limit.maxCents > cap) fail(`P4: Glim's ${limit.maxCents} on lot ${limit.lot + 1} is over the guest's ${cap} cap`);
  }
  for (const limit of after.limits) {
    if (limit.paddle !== GUEST || limit.owner !== "guest_max" || limit.active || limit.exhausted) continue;
    if (after.lots[limit.lot]?.status !== "closed") fail(`P5: the guest's own max on lot ${limit.lot + 1} ended without being outbid`);
  }
  if (JSON.stringify(after.holds) !== JSON.stringify(initialHolds)) fail("P8: a hold changed");
}

describe("the plan writer on Postgres", () => {
  it("keeps the mandate and the hold with raw changes, validated decisions and concurrent waves", { timeout: 900_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ config, spec, steps }) => {
        const armed = await arm(config, spec);
        let before = await armed.world.view();
        const initialHolds = before.holds;
        for (const [index, step] of steps.entries()) {
          const fail = (problem: string): never => {
            throw new Error(`step ${index} ${JSON.stringify(step)}: ${problem}`);
          };
          const read = await readContext(armed);
          if (step.kind === "wave") await Promise.all(step.ops.map((op) => runOp(armed, op, before, read)));
          else await runOp(armed, step, before, read);
          const after = await armed.world.view();
          await check(armed, before, after, initialHolds, fail);
          before = after;
        }
      }),
      { numRuns: Math.max(1, Math.ceil(propertyRuns(1_000) / 20)) },
    );
  });
});
