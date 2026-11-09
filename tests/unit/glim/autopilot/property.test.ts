import fc from "fast-check";
import { describe, it } from "vitest";

import { createLimits, removeLimit } from "@/server/engine";
import { commitmentCents, nextMinimumCents } from "@/server/engine/rules";
import { allocatePlan, type PlanLot } from "@/server/glim/allocator";
import { parseDecision } from "@/server/glim/autopilot/schema";
import {
  DECISION_REASONS,
  type AutopilotChange,
  type AutopilotContext,
  type PendingRaise,
} from "@/server/glim/autopilot/types";
import { checkDecision, toEngineChange } from "@/server/glim/autopilot/validate";
import type { GlimMandate } from "@/server/glim/mandate";
import type { GlimCommitment, GlimLotState, GlimState } from "@/server/glim/types";

import {
  commandArbitrary,
  createMemoryWorld,
  execute,
  invariantViolations,
  pick,
  propertyRuns,
  worldConfigArbitrary,
  type AuctionView,
  type Command,
  type WorldConfig,
} from "../../engine/support/auction-model";
import type { MemoryState } from "../../engine/support/memory-store";

/*
 * Glim's autopilot against the real engine on the in-memory store. Paddle 0 is the guest, with a
 * random mandate (a named budget or none, plan lots with caps, backups, exclusions) and a first
 * plan allocated as a confirmed card would be. Every existing engine command runs for every paddle,
 * the guest's own bids and maxes included; the autopilot command sends an adversarial decision
 * (unknown, excluded or closed lots, priorities -2..10, ceilings null, 0 or huge, raises up to
 * $2,000) through the real parseDecision, checkDecision and toEngineChange into createLimits or
 * removeLimit. After every command:
 *   P1 the engine's invariants hold (invariantViolations);
 *   P2 after an autopilot change, the guest's commitments on the mandate's lots are within the
 *      named budget, unless the change only lowered or dropped Glim's limits;
 *   P3 every Glim limit an autopilot step created is on a lot that was allowed at that step;
 *   P4 every active Glim limit of the guest is within the guest's cap;
 *   P5 no autopilot step ended or replaced a guest max;
 *   P6 the ranking rule held: no lot gained while a live lot the guest ranked higher lost;
 *   P7 a rejected decision changed nothing;
 *   P8 autopilot never touched a hold.
 * The checks below are written independently of src/server/glim, so a bug there shows up here.
 *
 * Mutation checks, run once on Nov 7, 2026 at 1,000 runs, each edit applied by hand and reverted:
 *   - budget rule removed (budgetForPlan returned the available hold, ignoring B): P2 failed
 *     ("39400 committed on the mandate's lots, over the 22600 budget", seed 1986785683);
 *   - exclusion filter removed (lotBlocker never returned excluded_lot): P3 failed (a limit on an
 *     excluded lot, seed 299621893);
 *   - cap repair removed (checkChange read every guest cap as null, so neither R4 nor the
 *     allocator's caps held): P4 failed ("29500 on lot 3 is over the guest's 5200 cap", seed 55377774);
 *   - guest-control filter removed (lotBlocker never returned guest_controlled_lot): P3 failed on
 *     the lot under the guest's own max, before the engine could replace it (seed -664831123).
 */

const GUEST = 0;
const TWO_MINUTES = 120_000;
const TEN_MINUTES = 600_000;
const CLOSE_MARGIN = 5_000;

interface MandateSpec {
  budgetDollars: number | null;
  planLots: { lot: number; priority: number; capDollars: number | null }[];
  backupLots: number[];
  excludedLots: number[];
}

type AutopilotCommand = {
  kind: "autopilot";
  decision: {
    action: string;
    lots: { lot_number: number; priority: number; max_dollars: number | null }[];
    raise_to_dollars: number | null;
    reason: string;
    why: string;
  };
};

type Step = Command | AutopilotCommand;

function mandateArbitrary(config: WorldConfig): fc.Arbitrary<MandateSpec> {
  const lotCount = config.lots.length;
  return fc
    .shuffledSubarray(
      Array.from({ length: lotCount }, (_, index) => index),
      { minLength: 1, maxLength: lotCount },
    )
    .chain((order) =>
      fc.record({
        budgetDollars: fc.option(fc.integer({ min: 20, max: 800 }), { nil: null }),
        planCount: fc.integer({ min: 1, max: order.length }),
        backupCount: fc.nat({ max: order.length }),
        caps: fc.array(fc.option(fc.integer({ min: 10, max: 400 }), { nil: null, freq: 2 }), { minLength: lotCount, maxLength: lotCount }),
        priorities: fc.array(fc.integer({ min: 1, max: 3 }), { minLength: lotCount, maxLength: lotCount }),
        order: fc.constant(order),
      }),
    )
    .map(({ budgetDollars, planCount, backupCount, caps, priorities, order }) => {
      const planned = order.slice(0, planCount);
      const rest = order.slice(planCount);
      const backups = rest.slice(0, Math.min(backupCount, rest.length));
      const excluded = rest.slice(backups.length);
      return {
        budgetDollars,
        planLots: planned.map((lot) => ({ lot, priority: priorities[lot] ?? 1, capDollars: caps[lot] ?? null })),
        backupLots: backups,
        excludedLots: excluded,
      };
    });
}

function autopilotArbitrary(config: WorldConfig, mandate: MandateSpec): fc.Arbitrary<AutopilotCommand> {
  const mandateLots = [...mandate.planLots.map((entry) => entry.lot), ...mandate.backupLots, ...mandate.excludedLots].map((lot) => lot + 1);
  // Mostly the mandate's lots, then any lot (excluded ones included), lot n+1 (unknown) and lot 0,
  // a priority below 1, a $0 ceiling or a $0 raise, which the parser rejects.
  const lotNumber = fc.oneof(
    { weight: 16, arbitrary: fc.constantFrom(...mandateLots) },
    { weight: 6, arbitrary: fc.integer({ min: 1, max: config.lots.length + 1 }) },
    { weight: 1, arbitrary: fc.constant(0) },
  );
  return fc.record({
    kind: fc.constant("autopilot" as const),
    decision: fc.record({
      action: fc.constantFrom("keep", "change", "change", "change", "change", "prepare_raise", "prepare_raise"),
      lots: fc.uniqueArray(
        fc.record({
          lot_number: lotNumber,
          priority: fc.oneof({ weight: 1, arbitrary: fc.integer({ min: -2, max: 0 }) }, { weight: 30, arbitrary: fc.integer({ min: 1, max: 10 }) }),
          max_dollars: fc.oneof(
            { weight: 12, arbitrary: fc.constant(null) },
            { weight: 1, arbitrary: fc.constant(0) },
            { weight: 10, arbitrary: fc.integer({ min: 1, max: 800 }) },
            { weight: 4, arbitrary: fc.constant(1_000_000) },
          ),
        }),
        { maxLength: config.lots.length + 1, selector: (entry) => entry.lot_number },
      ),
      raise_to_dollars: fc.oneof(
        { weight: 6, arbitrary: fc.constant(null) },
        { weight: 6, arbitrary: fc.integer({ min: 1, max: 2_000 }) },
        { weight: 1, arbitrary: fc.constant(0) },
      ),
      reason: fc.constantFrom(...DECISION_REASONS),
      why: fc.constant(""),
    }),
  });
}

const scenarioArbitrary = worldConfigArbitrary
  // The guest always has a hold, so autopilot has room to act.
  .map((config) => ({ ...config, holds: config.holds.map((hold, index) => (index === GUEST ? (hold ?? 30_000) : hold)) }))
  .chain((config) =>
    mandateArbitrary(config).chain((mandate) =>
      fc.record({
        config: fc.constant(config),
        mandate: fc.constant(mandate),
        steps: fc.array(
          fc.oneof(
            { weight: 3, arbitrary: commandArbitrary(config) as fc.Arbitrary<Step> },
            { weight: 3, arbitrary: autopilotArbitrary(config, mandate) as fc.Arbitrary<Step> },
          ),
          { minLength: 1, maxLength: 40, size: "max" },
        ),
      }),
    ),
  );

/** What the test tracks about the guest's plan, as the plan row would. */
interface Tracker {
  mandate: GlimMandate;
  confirmedAt: number;
  version: number;
  paused: boolean;
  /** Lot id and the memory-clock moment autopilot dropped it. */
  dropped: Map<string, number>;
  pendingRaise: PendingRaise | null;
  raises: number;
}

function guestLimits(state: MemoryState, paddleId: string) {
  return [...state.limits.values()].filter((limit) => limit.paddleId === paddleId);
}

/** The guest's view of the memory world, as loadGlimState builds it from Postgres. */
function glimState(state: MemoryState, eventId: string, paddleId: string, lotIds: readonly string[]): GlimState {
  const now = state.clock + 1;
  const hold = [...state.holds.values()].find((entry) => entry.paddleId === paddleId && entry.status === "authorized");
  const lots: GlimLotState[] = lotIds.map((id) => {
    const lot = state.lots.get(id);
    if (!lot) throw new Error(`no lot ${id}`);
    const hasBid = state.bids.some((bid) => bid.lotId === id && bid.paddleId === paddleId);
    const guestStatus: GlimLotState["guestStatus"] =
      lot.status === "closed"
        ? lot.winningPaddleId === paddleId
          ? "won"
          : hasBid
            ? "lost"
            : "none"
        : lot.highPaddleId === paddleId
          ? "winning"
          : hasBid
            ? "outbid"
            : "none";
    return {
      id,
      number: lot.number,
      shortTitle: `Lot ${lot.number}`,
      category: "dining",
      status: lot.status,
      closesAt: new Date(lot.closesAt),
      currentBidCents: lot.currentBidCents,
      bidCount: lot.bidCount,
      nextMinimumCents: nextMinimumCents(lot),
      minRaiseCents: lot.minRaiseCents,
      guestStatus,
    };
  });
  const commitments: GlimCommitment[] = lotIds.flatMap((id): GlimCommitment[] => {
    const lot = state.lots.get(id);
    if (!lot) return [];
    const limit = guestLimits(state, paddleId).find((entry) => entry.active && entry.lotId === id);
    const cents = commitmentCents(lot, paddleId, limit?.maxCents ?? null);
    if (cents === 0) return [];
    const leading = lot.status !== "closed" && lot.highPaddleId === paddleId ? (lot.currentBidCents ?? 0) : 0;
    if (lot.status === "closed") return [{ lotNumber: lot.number, source: "won" as const, cents, withoutGlimCents: cents }];
    if (limit && limit.maxCents >= leading) {
      return [
        limit.owner === "glim"
          ? { lotNumber: lot.number, source: "glim_limit" as const, cents, withoutGlimCents: leading }
          : { lotNumber: lot.number, source: "guest_max" as const, cents, withoutGlimCents: cents },
      ];
    }
    return [{ lotNumber: lot.number, source: "winning_bid" as const, cents, withoutGlimCents: cents }];
  });
  return {
    now: new Date(now),
    event: { id: eventId, timezone: "America/Los_Angeles", holdPresetsCents: [25_000, 50_000, 100_000], holdMinCents: 1_000, holdMaxCents: 100_000 },
    guest: { paddleId, paddleNumber: 100, firstName: "Guest" },
    holdCents: hold?.amountCents ?? null,
    lots,
    commitments,
    plan: null,
    favoriteLotNumbers: [],
    openedFromLotNumber: null,
  };
}

/** The test adapter: the autopilot's context from the memory world. */
function contextFrom(world: ReturnType<typeof createMemoryWorld>, tracker: Tracker): AutopilotContext {
  const { state } = world.store;
  const paddleId = pick(world.paddleIds, GUEST);
  const glim = glimState(state, world.eventId, paddleId, world.lotIds);
  const now = glim.now.getTime();
  const limits = guestLimits(state, paddleId);
  const active = limits.filter((limit) => limit.active);
  return {
    state: glim,
    plan: {
      id: "plan",
      version: tracker.version,
      status: "active",
      items: active
        .filter((limit) => limit.owner === "glim")
        .map((limit) => ({ id: `item-${limit.lotId}`, lotId: limit.lotId, lotNumber: state.lots.get(limit.lotId)?.number ?? 0, priority: 1, maxCents: limit.maxCents })),
    },
    mandate: tracker.mandate,
    limits: active.map((limit) => ({
      id: limit.id,
      lotId: limit.lotId,
      lotNumber: state.lots.get(limit.lotId)?.number ?? 0,
      owner: limit.owner,
      maxCents: limit.maxCents,
      createdAt: new Date(limit.createdAt),
    })),
    guestControlledLotIds: limits
      .filter((limit) => limit.owner === "guest_max" && (limit.active || limit.createdAt >= tracker.confirmedAt))
      .map((limit) => limit.lotId),
    contestedLotIds: limits
      .filter((limit) => limit.owner === "glim" && limit.exhaustedAt !== null && limit.exhaustedAt === limit.createdAt && limit.createdAt > now - TEN_MINUTES)
      .map((limit) => limit.lotId),
    recentlyDroppedLotIds: [...tracker.dropped].filter(([, at]) => at > now - TWO_MINUTES).map(([lotId]) => lotId),
    recentDecisions: [],
    pendingRaise: tracker.pendingRaise,
    raisesPrepared: tracker.raises,
    triggers: [],
  };
}

/** Independently of src/server/glim: may autopilot put money on this lot? */
function allowed(context: AutopilotContext, lotId: string): boolean {
  const { mandate, state } = context;
  const lot = state.lots.find((candidate) => candidate.id === lotId);
  if (!lot || !mandate.lots.some((entry) => entry.lotId === lotId) || mandate.excludedLotIds.includes(lotId)) return false;
  if (lot.status !== "open" || lot.closesAt.getTime() - state.now.getTime() <= CLOSE_MARGIN) return false;
  return (
    !context.guestControlledLotIds.includes(lotId) &&
    !context.contestedLotIds.includes(lotId) &&
    !context.recentlyDroppedLotIds.includes(lotId)
  );
}

function confirmFirstPlan(world: ReturnType<typeof createMemoryWorld>, spec: MandateSpec): Promise<Tracker> {
  const lotId = (index: number) => pick(world.lotIds, index);
  const planRank = Math.max(...spec.planLots.map((entry) => entry.priority));
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
      ...spec.backupLots.map((lot, index) => ({
        lotId: lotId(lot),
        lotNumber: lot + 1,
        role: "backup" as const,
        source: index % 2 === 0 ? ("words" as const) : ("heart" as const),
        rank: planRank + (index % 2 === 0 ? 1 : 2),
        capCents: null,
      })),
      // Every other excluded lot stays among the lots, as a skipped one does (skipLot).
      ...spec.excludedLots
        .filter((_, index) => index % 2 === 0)
        .map((lot) => ({ lotId: lotId(lot), lotNumber: lot + 1, role: "backup" as const, source: "words" as const, rank: planRank + 1, capCents: null })),
    ],
    excludedLotIds: spec.excludedLots.map(lotId),
    guestWords: [],
    confirmedAt: new Date(world.store.state.clock).toISOString(),
  };
  const tracker: Tracker = {
    mandate,
    confirmedAt: world.store.state.clock,
    version: 1,
    paused: false,
    dropped: new Map(),
    pendingRaise: null,
    raises: 0,
  };
  return (async () => {
    // The first plan, priced as a confirmed card would be: caps first, the rest to priority 1.
    const context = contextFrom(world, tracker);
    const planLots: PlanLot[] = spec.planLots.flatMap((entry) => {
      const lot = context.state.lots.find((candidate) => candidate.id === lotId(entry.lot));
      return lot ? [{ lot, priority: entry.priority, capCents: entry.capDollars === null ? null : entry.capDollars * 100 }] : [];
    });
    const allocation = allocatePlan({
      holdCents: context.state.holdCents ?? 0,
      budgetCents: mandate.budgetCents,
      commitments: context.state.commitments,
      planLots,
    });
    const items = allocation.items.filter((item) => item.maxCents >= item.floorCents && item.maxCents > 0);
    const total = items.reduce((sum, item) => sum + item.maxCents, 0);
    if (items.length > 0 && total <= allocation.limitCents) {
      await createLimits(
        pick(world.paddleIds, GUEST),
        items.map((item) => ({ lotId: item.lot.id, maxCents: item.maxCents })),
        { ...world.engine, owner: "glim" },
      );
    }
    tracker.confirmedAt = world.store.state.clock;
    tracker.mandate = { ...tracker.mandate, confirmedAt: new Date(tracker.confirmedAt).toISOString() };
    return tracker;
  })();
}

type GlimLimitView = { lot: number; maxCents: number };
const activeGlim = (view: AuctionView): GlimLimitView[] =>
  view.limits.filter((limit) => limit.paddle === GUEST && limit.owner === "glim" && limit.active).map(({ lot, maxCents }) => ({ lot, maxCents }));
const glimCount = (view: AuctionView, lot: number) =>
  view.limits.filter((limit) => limit.paddle === GUEST && limit.owner === "glim" && limit.lot === lot).length;

function spendOnMandate(view: AuctionView, mandate: GlimMandate, lotIds: readonly string[]): number {
  const inMandate = new Set(mandate.lots.map((entry) => lotIds.indexOf(entry.lotId)));
  return view.lots.reduce((sum, lot, index) => {
    if (!inMandate.has(index)) return sum;
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

async function autopilotStep(
  world: ReturnType<typeof createMemoryWorld>,
  tracker: Tracker,
  step: AutopilotCommand,
  before: AuctionView,
  fail: (problem: string) => never,
): Promise<string> {
  const paddleId = pick(world.paddleIds, GUEST);
  const context = contextFrom(world, tracker);
  if (tracker.paused) return "paused";
  const parsed = parseDecision(JSON.stringify(step.decision));
  if (!parsed.ok) return "invalid";
  const check = checkDecision(parsed.decision, context);
  if (!check.ok) return "rejected";
  if (check.action === "keep") return "keep";
  if (check.action === "prepare_raise") {
    tracker.raises += 1;
    tracker.pendingRaise = {
      actionId: `raise-${tracker.raises}`,
      amountCents: check.amountCents,
      createdAt: context.state.now,
      approved: false,
      lots: parsed.decision.lots,
    };
    return "raise";
  }

  const change: AutopilotChange = check.change;
  const rank = (lotId: string) => tracker.mandate.lots.find((entry) => entry.lotId === lotId)?.rank ?? Number.POSITIVE_INFINITY;
  // P6, on the change as decided, against the live limits the context read.
  const beforeMax = new Map(context.limits.filter((limit) => limit.owner === "glim").map((limit) => [limit.lotId, limit.maxCents]));
  const afterMax = new Map(change.after.map((lot) => [lot.lotId, lot.maxCents]));
  const losers = [...beforeMax].filter(([lotId, max]) => (afterMax.get(lotId) ?? 0) < max).map(([lotId]) => lotId);
  const gainers = [...afterMax].filter(([lotId, max]) => max > (beforeMax.get(lotId) ?? 0)).map(([lotId]) => lotId);
  for (const gainer of gainers) {
    for (const loser of losers) if (rank(gainer) > rank(loser)) fail(`P6: lot ${gainer} gained while ${loser}, ranked higher, lost`);
  }
  // P3, for every lot the change will give a new limit.
  for (const lot of change.set) if (!allowed(context, lot.lotId)) fail(`P3: autopilot set a limit on lot ${lot.lotNumber}, which was not allowed`);

  const engine = toEngineChange(change);
  if (engine.items.length > 0) {
    const result = await createLimits(paddleId, engine.items, { ...world.engine, owner: "glim", removeLotIds: engine.removeLotIds });
    if (!result.ok) return `refused:${result.refusal.reason}`;
  } else {
    for (const lotId of engine.removeLotIds) await removeLimit(paddleId, lotId, { ...world.engine, owner: "glim" });
  }
  tracker.version += 1;
  tracker.pendingRaise = null;
  for (const lotId of engine.removeLotIds) tracker.dropped.set(lotId, world.store.state.clock);

  const after = await world.view();
  // P2: within the named budget, unless every Glim limit only went down or ended.
  const lowerOrDropOnly = activeGlim(after).every((limit) => {
    const previous = activeGlim(before).find((entry) => entry.lot === limit.lot);
    return previous !== undefined && limit.maxCents <= previous.maxCents;
  });
  const budget = tracker.mandate.budgetCents;
  const spend = spendOnMandate(after, tracker.mandate, world.lotIds);
  if (budget !== null && spend > budget && !lowerOrDropOnly) fail(`P2: ${spend} committed on the mandate's lots, over the ${budget} budget`);
  // P3 again, on the world: any new Glim limit of the guest sits on a lot that was allowed.
  world.lotIds.forEach((lotId, index) => {
    if (glimCount(after, index) > glimCount(before, index) && !allowed(context, lotId)) fail(`P3: a new Glim limit on lot ${index + 1}`);
  });
  return "applied";
}

describe("Glim's autopilot inside the mandate", () => {
  it("keeps P1-P8 across random engine commands and adversarial decisions", { timeout: 600_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ config, mandate, steps }) => {
        const world = createMemoryWorld(config);
        const tracker = await confirmFirstPlan(world, mandate);
        let before = await world.view();
        for (const [index, step] of steps.entries()) {
          const fail = (problem: string): never => {
            throw new Error(`step ${index} ${JSON.stringify(step)}: ${problem}`);
          };
          let outcome: string;
          if (step.kind === "autopilot") {
            outcome = await autopilotStep(world, tracker, step, before, fail);
          } else {
            // The guest's Glim limits come only from the confirmed plan and from autopilot.
            const command = step.kind === "plan" && step.paddle === GUEST ? { ...step, paddle: 1 } : step;
            outcome = await execute(world, command, before);
            if (command.kind === "pause" && command.paddle === GUEST) tracker.paused = true;
            if (command.kind === "resume" && command.paddle === GUEST) tracker.paused = false;
          }
          const after = await world.view();

          const problems = invariantViolations(after);
          if (problems.length > 0) fail(`P1: ${problems.join("; ")}`);
          for (const limit of activeGlim(after)) {
            const cap = tracker.mandate.lots.find((entry) => world.lotIds.indexOf(entry.lotId) === limit.lot)?.capCents ?? null;
            if (cap !== null && limit.maxCents > cap) fail(`P4: Glim's ${limit.maxCents} on lot ${limit.lot + 1} is over the guest's ${cap} cap`);
          }
          if (step.kind === "autopilot") {
            const guestMaxes = (view: AuctionView) =>
              view.limits.filter((limit) => limit.paddle === GUEST && limit.owner === "guest_max" && limit.active).map((limit) => `${limit.lot}/${limit.maxCents}`);
            const kept = guestMaxes(after);
            if (guestMaxes(before).some((entry) => !kept.includes(entry))) fail("P5: autopilot ended or replaced a guest max");
            if (outcome !== "applied" && JSON.stringify(after) !== JSON.stringify(before)) fail(`P7: a ${outcome} decision changed the world`);
            if (JSON.stringify(after.holds) !== JSON.stringify(before.holds)) fail("P8: autopilot touched a hold");
          }
          before = after;
        }
      }),
      { numRuns: propertyRuns(1_000) },
    );
  });
});
