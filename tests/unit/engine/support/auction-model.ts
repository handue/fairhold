/**
 * The model the property tests share: a small auction world, random commands over it, and the
 * properties every state must satisfy. A World is backed by the in-memory store (unit tests) or
 * by Postgres (integration tests); the commands go through the real engine actions either way.
 */
import fc from "fast-check";

import {
  closeDueLots,
  closeEvent,
  createLimits,
  pauseLimits,
  placeBid,
  removeLimit,
  resumeLimits,
  setMaxBid,
  type EngineOptions,
} from "@/server/engine";
import { commitmentCents, nextMinimumCents } from "@/server/engine/rules";
import type { BidSource, Cents, EventStatus, LimitOwner, LotStatus } from "@/server/engine/types";

import { MemoryEngineStore, type MemoryState } from "./memory-store";

export interface WorldConfig {
  lots: { startingBidCents: Cents; minRaiseCents: Cents }[];
  /** One entry per paddle: its authorized hold, or null for a paddle that never set one. */
  holds: (Cents | null)[];
}

export interface ViewLot {
  status: LotStatus;
  startingBidCents: Cents;
  minRaiseCents: Cents;
  currentBidCents: Cents | null;
  bidCount: number;
  highPaddle: number | null;
  winningPaddle: number | null;
  winningCents: Cents | null;
  /** The next transaction will be at or after closes_at. */
  pastClose: boolean;
}

export interface ViewBid {
  lot: number;
  paddle: number;
  amountCents: Cents;
  source: BidSource;
  /** The max of the limit that placed the bid; null for manual bids. */
  limitMaxCents: Cents | null;
  createdBeforeClose: boolean;
  createdBeforeLotClosed: boolean;
}

export interface ViewLimit {
  paddle: number;
  lot: number;
  maxCents: Cents;
  owner: LimitOwner;
  active: boolean;
  paused: boolean;
  exhausted: boolean;
}

/** A store-independent picture of the world, with ids replaced by lot and paddle indexes. */
export interface AuctionView {
  eventStatus: EventStatus;
  lots: ViewLot[];
  /** Per lot, in the order the bids were placed. */
  bids: ViewBid[];
  /** In a canonical order, so views from different stores compare equal. */
  limits: ViewLimit[];
  holds: (Cents | null)[];
}

export interface World {
  readonly eventId: string;
  readonly lotIds: readonly string[];
  readonly paddleIds: readonly string[];
  readonly engine: EngineOptions;
  view(): Promise<AuctionView>;
  /** Moves the lot's closes_at to now, as the demo's "Close next lot" does. */
  expireLot(lot: number): Promise<void>;
  /** Replaces the paddle's hold with a larger one, as the raise flow does. */
  raiseHold(paddle: number, amountCents: Cents): Promise<void>;
}

export type Command =
  | { kind: "bid"; paddle: number; lot: number; raises: number; extraCents: number }
  | { kind: "max"; paddle: number; lot: number; raises: number }
  | { kind: "plan"; paddle: number; items: { lot: number; raises: number }[]; dropLots: number[] }
  | { kind: "remove"; paddle: number; lot: number }
  | { kind: "pause"; paddle: number }
  | { kind: "resume"; paddle: number }
  | { kind: "raiseHold"; paddle: number; extraCents: number }
  | { kind: "expire"; lot: number }
  | { kind: "tick" }
  | { kind: "closeEvent" };

export function pick<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`index ${index} out of range`);
  return item;
}

export const worldConfigArbitrary: fc.Arbitrary<WorldConfig> = fc.record({
  lots: fc.array(
    fc.record({
      startingBidCents: fc.integer({ min: 5, max: 50 }).map((dollars) => dollars * 100),
      minRaiseCents: fc.constantFrom(100, 250, 500, 1_000, 2_000),
    }),
    { minLength: 2, maxLength: 4 },
  ),
  holds: fc.array(
    fc.option(
      fc.integer({ min: 20, max: 600 }).map((dollars) => dollars * 100),
      { freq: 6 },
    ),
    { minLength: 3, maxLength: 5 },
  ),
});

export function commandArbitrary(config: WorldConfig): fc.Arbitrary<Command> {
  const paddle = fc.nat({ max: config.holds.length - 1 });
  const lot = fc.nat({ max: config.lots.length - 1 });
  return fc.oneof(
    {
      weight: 20,
      arbitrary: fc.record({
        kind: fc.constant("bid" as const),
        paddle,
        lot,
        raises: fc.integer({ min: -1, max: 12 }),
        extraCents: fc.constantFrom(0, 0, 0, 1, 99),
      }),
    },
    {
      weight: 10,
      arbitrary: fc.record({ kind: fc.constant("max" as const), paddle, lot, raises: fc.integer({ min: -1, max: 15 }) }),
    },
    {
      weight: 8,
      arbitrary: fc.record({
        kind: fc.constant("plan" as const),
        paddle,
        items: fc.uniqueArray(fc.record({ lot, raises: fc.integer({ min: -1, max: 10 }) }), {
          minLength: 1,
          maxLength: config.lots.length,
          selector: (item) => item.lot,
        }),
        dropLots: fc.uniqueArray(lot, { maxLength: 2 }),
      }),
    },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("remove" as const), paddle, lot }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("pause" as const), paddle }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("resume" as const), paddle }) },
    {
      weight: 2,
      arbitrary: fc.record({
        kind: fc.constant("raiseHold" as const),
        paddle,
        extraCents: fc.integer({ min: 1, max: 200 }).map((dollars) => dollars * 100),
      }),
    },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("expire" as const), lot }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("tick" as const) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("closeEvent" as const) }) },
  );
}

export const scenarioArbitrary = worldConfigArbitrary.chain((config) =>
  fc.record({
    config: fc.constant(config),
    commands: fc.array(commandArbitrary(config), { minLength: 1, maxLength: 50, size: "max" }),
  }),
);

/** The configured number of runs, raised with FAST_CHECK_RUNS. */
export function propertyRuns(defaultRuns: number): number {
  const configured = Number.parseInt(process.env.FAST_CHECK_RUNS ?? "", 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : defaultRuns;
}

function lotMinimum(lot: ViewLot): Cents {
  return nextMinimumCents({
    highPaddleId: lot.highPaddle === null ? null : String(lot.highPaddle),
    currentBidCents: lot.currentBidCents,
    startingBidCents: lot.startingBidCents,
    minRaiseCents: lot.minRaiseCents,
  });
}

function amountFor(lot: ViewLot, raises: number, extraCents = 0): Cents {
  return Math.max(1, lotMinimum(lot) + raises * lot.minRaiseCents + extraCents);
}

/** Runs one command through the engine; returns "ok" or the refusal reason. */
export async function execute(world: World, command: Command, before: AuctionView): Promise<string> {
  const paddleId = (index: number) => pick(world.paddleIds, index);
  const lotId = (index: number) => pick(world.lotIds, index);
  switch (command.kind) {
    case "bid": {
      const amount = amountFor(pick(before.lots, command.lot), command.raises, command.extraCents);
      const result = await placeBid(paddleId(command.paddle), lotId(command.lot), amount, "guest", world.engine);
      return result.ok ? "ok" : result.refusal.reason;
    }
    case "max": {
      const max = amountFor(pick(before.lots, command.lot), command.raises);
      const result = await setMaxBid(paddleId(command.paddle), lotId(command.lot), max, world.engine);
      return result.ok ? "ok" : result.refusal.reason;
    }
    case "plan": {
      const items = command.items.map((item) => ({
        lotId: lotId(item.lot),
        maxCents: amountFor(pick(before.lots, item.lot), item.raises),
      }));
      const planned = new Set(command.items.map((item) => item.lot));
      const removeLotIds = command.dropLots.filter((lot) => !planned.has(lot)).map(lotId);
      const result = await createLimits(paddleId(command.paddle), items, { ...world.engine, removeLotIds });
      return result.ok ? "ok" : result.refusal.reason;
    }
    case "remove":
      await removeLimit(paddleId(command.paddle), lotId(command.lot), world.engine);
      return "ok";
    case "pause":
      await pauseLimits(paddleId(command.paddle), world.engine);
      return "ok";
    case "resume":
      await resumeLimits(paddleId(command.paddle), world.engine);
      return "ok";
    case "raiseHold": {
      const current = before.holds[command.paddle] ?? 0;
      await world.raiseHold(command.paddle, current + command.extraCents);
      return "ok";
    }
    case "expire":
      await world.expireLot(command.lot);
      return "ok";
    case "tick":
      await closeDueLots(undefined, world.engine);
      return "ok";
    case "closeEvent":
      await closeEvent(world.eventId, world.engine);
      return "ok";
  }
}

const BID_COMMANDS: ReadonlySet<Command["kind"]> = new Set(["bid", "max", "plan"]);

function lotsTouched(command: Command): number[] {
  switch (command.kind) {
    case "bid":
    case "max":
      return [command.lot];
    case "plan":
      return command.items.map((item) => item.lot);
    default:
      return [];
  }
}

/**
 * Runs the commands one by one and fails on the first broken property: a refused command must
 * leave the world unchanged, a command on a lot past its close must be refused, and every state
 * must satisfy invariantViolations. Returns the outcome of each command.
 */
export async function runScenario(world: World, commands: readonly Command[]): Promise<string[]> {
  const outcomes: string[] = [];
  let before = await world.view();
  for (const [step, command] of commands.entries()) {
    const outcome = await execute(world, command, before);
    outcomes.push(outcome);
    const after = await world.view();
    const fail = (problem: string) => {
      throw new Error(`step ${step} ${JSON.stringify(command)} -> ${outcome}: ${problem}`);
    };

    if (outcome !== "ok" && JSON.stringify(after) !== JSON.stringify(before)) {
      fail("a refused command changed the world");
    }
    if (BID_COMMANDS.has(command.kind)) {
      const closedLot = lotsTouched(command).find((lot) => {
        const state = pick(before.lots, lot);
        return state.status === "closed" || state.pastClose || before.eventStatus !== "live";
      });
      if (closedLot !== undefined && outcome !== "lot_closed") fail(`lot ${closedLot} was past its close`);
    }
    const problems = invariantViolations(after);
    if (problems.length > 0) fail(problems.join("; "));
    before = after;
  }
  return outcomes;
}

/** Every property a reachable state must have; empty when all hold. */
export function invariantViolations(view: AuctionView): string[] {
  const problems: string[] = [];
  const activeLimit = (paddle: number, lot: number) =>
    view.limits.find((limit) => limit.active && limit.paddle === paddle && limit.lot === lot);

  view.holds.forEach((hold, paddle) => {
    const committed = view.lots.reduce((sum, lot, index) => {
      const asIds = {
        status: lot.status,
        highPaddleId: lot.highPaddle === null ? null : String(lot.highPaddle),
        currentBidCents: lot.currentBidCents,
        winningPaddleId: lot.winningPaddle === null ? null : String(lot.winningPaddle),
        winningCents: lot.winningCents,
      };
      return sum + commitmentCents(asIds, String(paddle), activeLimit(paddle, index)?.maxCents ?? null);
    }, 0);
    if (committed > (hold ?? 0)) problems.push(`paddle ${paddle} commits ${committed} over its hold ${hold ?? 0}`);
  });

  view.lots.forEach((lot, index) => {
    const bids = view.bids.filter((bid) => bid.lot === index);
    const last = bids.at(-1);
    bids.forEach((bid, position) => {
      const previous = bids[position - 1];
      const minimum = previous ? previous.amountCents + lot.minRaiseCents : lot.startingBidCents;
      if (bid.amountCents < minimum) problems.push(`lot ${index}: bid ${bid.amountCents} under minimum ${minimum}`);
      if (!bid.createdBeforeClose) problems.push(`lot ${index}: bid ${bid.amountCents} at or after closes_at`);
      if (!bid.createdBeforeLotClosed) problems.push(`lot ${index}: bid ${bid.amountCents} after the lot closed`);
      if (bid.limitMaxCents !== null && bid.amountCents > bid.limitMaxCents) {
        problems.push(`lot ${index}: proxy bid ${bid.amountCents} over its limit ${bid.limitMaxCents}`);
      }
      if (bid.limitMaxCents !== null && bid.amountCents !== minimum) {
        problems.push(`lot ${index}: proxy bid ${bid.amountCents} is not the minimum raise ${minimum}`);
      }
    });
    if (lot.bidCount !== bids.length) problems.push(`lot ${index}: bid_count ${lot.bidCount} for ${bids.length} bids`);
    if ((lot.currentBidCents ?? null) !== (last?.amountCents ?? null) || lot.highPaddle !== (last?.paddle ?? null)) {
      problems.push(`lot ${index}: current bid is not the highest accepted bid`);
    }
    if (lot.status === "closed") {
      if (lot.winningPaddle !== (last?.paddle ?? null) || lot.winningCents !== (last?.amountCents ?? null)) {
        problems.push(`lot ${index}: winner is not the highest accepted bid`);
      }
      if (view.limits.some((limit) => limit.lot === index && limit.active)) {
        problems.push(`lot ${index}: closed with an active limit`);
      }
    } else if (lot.winningPaddle !== null || lot.winningCents !== null) {
      problems.push(`lot ${index}: open with a winner`);
    }
    // Proxy bidding repeats until stable: no limit that may still bid is left waiting.
    if (lot.status === "open" && !lot.pastClose && view.eventStatus === "live") {
      const minimum = lotMinimum(lot);
      const waiting = view.limits.find(
        (limit) =>
          limit.lot === index &&
          limit.active &&
          !limit.paused &&
          limit.paddle !== lot.highPaddle &&
          limit.maxCents >= minimum &&
          view.holds[limit.paddle] !== null,
      );
      if (waiting) problems.push(`lot ${index}: paddle ${waiting.paddle}'s limit ${waiting.maxCents} did not answer`);
    }
    // A limit outbid past its max can never bid again, so it must stop reserving the hold.
    if (lot.status === "open") {
      const minimum = lotMinimum(lot);
      const spent = view.limits.find(
        (limit) => limit.lot === index && limit.active && limit.paddle !== lot.highPaddle && limit.maxCents < minimum,
      );
      if (spent) problems.push(`lot ${index}: paddle ${spent.paddle}'s spent limit ${spent.maxCents} is still active`);
    }
  });

  const activeKeys = view.limits.filter((limit) => limit.active).map((limit) => `${limit.paddle}/${limit.lot}`);
  if (new Set(activeKeys).size !== activeKeys.length) problems.push("two active limits for one paddle and lot");
  if (view.eventStatus === "closed" && view.lots.some((lot) => lot.status === "open")) {
    problems.push("event closed with a lot still open");
  }
  return problems;
}

export function sortLimits(limits: ViewLimit[]): ViewLimit[] {
  return limits.sort((a, b) =>
    JSON.stringify([a.lot, a.paddle, a.owner, a.maxCents, a.active, a.paused, a.exhausted]).localeCompare(
      JSON.stringify([b.lot, b.paddle, b.owner, b.maxCents, b.active, b.paused, b.exhausted]),
    ),
  );
}

export function createMemoryWorld(config: WorldConfig): World & { store: MemoryEngineStore } {
  const store = new MemoryEngineStore();
  const eventId = store.addEvent("live");
  const paddleIds = config.holds.map((_, index) => store.addPaddle(eventId, 100 + index));
  config.holds.forEach((hold, index) => {
    if (hold !== null) store.addHold(pick(paddleIds, index), hold);
  });
  const lotIds = config.lots.map((lot, index) => store.addLot(eventId, { number: index + 1, ...lot }));
  return {
    store,
    eventId,
    lotIds,
    paddleIds,
    engine: { store },
    view: async () => memoryView(store.state, eventId, lotIds, paddleIds),
    expireLot: async (lot) => store.expireLot(pick(lotIds, lot)),
    raiseHold: async (paddle, amountCents) => {
      store.addHold(pick(paddleIds, paddle), amountCents);
    },
  };
}

function memoryView(
  state: MemoryState,
  eventId: string,
  lotIds: readonly string[],
  paddleIds: readonly string[],
): AuctionView {
  const paddleIndex = (id: string | null) => (id === null ? null : paddleIds.indexOf(id));
  const lots = lotIds.map((id) => {
    const lot = state.lots.get(id);
    if (!lot) throw new Error(`no lot ${id}`);
    return lot;
  });
  return {
    eventStatus: state.events.get(eventId)?.status ?? "draft",
    lots: lots.map((lot) => ({
      status: lot.status,
      startingBidCents: lot.startingBidCents,
      minRaiseCents: lot.minRaiseCents,
      currentBidCents: lot.currentBidCents,
      bidCount: lot.bidCount,
      highPaddle: paddleIndex(lot.highPaddleId),
      winningPaddle: paddleIndex(lot.winningPaddleId),
      winningCents: lot.winningCents,
      pastClose: state.clock + 1 >= lot.closesAt,
    })),
    bids: lots.flatMap((lot, lotIndex) =>
      state.bids
        .filter((bid) => bid.lotId === lot.id)
        .map((bid) => ({
          lot: lotIndex,
          paddle: paddleIds.indexOf(bid.paddleId),
          amountCents: bid.amountCents,
          source: bid.source,
          limitMaxCents: bid.limitId === null ? null : (state.limits.get(bid.limitId)?.maxCents ?? null),
          createdBeforeClose: bid.createdAt < lot.closesAt,
          createdBeforeLotClosed: lot.closedAt === null || bid.createdAt < lot.closedAt,
        })),
    ),
    limits: sortLimits(
      [...state.limits.values()].map((limit) => ({
        paddle: paddleIds.indexOf(limit.paddleId),
        lot: lotIds.indexOf(limit.lotId),
        maxCents: limit.maxCents,
        owner: limit.owner,
        active: limit.active,
        paused: limit.pausedAt !== null,
        exhausted: limit.exhaustedAt !== null,
      })),
    ),
    holds: paddleIds.map(
      (paddleId) =>
        [...state.holds.values()].find((hold) => hold.paddleId === paddleId && hold.status === "authorized")
          ?.amountCents ?? null,
    ),
  };
}
