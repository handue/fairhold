import type pg from "pg";

import { getPool } from "@/server/db/client";

import { assertCents, EngineError } from "./errors";
import { sortedUnique } from "./ids";
import { createPgStore } from "./pg-store";
import { refused, type Outcome } from "./refusals";
import { biddingGate } from "./rules";
import type { EngineStore, EngineTx } from "./store";
import {
  MANUAL_BID_SOURCES,
  type Cents,
  type LimitOwner,
  type LimitView,
  type LotView,
  type ManualBidSource,
  type PlacedBid,
} from "./types";
import { AuctionWorkspace } from "./workspace";

export interface EngineOptions {
  /** Defaults to Postgres through `pool`. Tests pass an in-memory store. */
  store?: EngineStore;
  /** Defaults to the process-wide pool. */
  pool?: pg.Pool;
}

export function resolveStore(options: EngineOptions = {}): EngineStore {
  return options.store ?? createPgStore(options.pool ?? getPool());
}

export type PlaceBidResult = Outcome<{
  bid: PlacedBid;
  /** Bids that limits placed in response, in order (rivals' and the bidder's own). */
  proxyBids: PlacedBid[];
  lot: LotView;
  /** Whether the bidder still leads once every limit has answered. */
  leading: boolean;
}>;

/**
 * A guest's (or a bot's) bid. One transaction: lock the lot, then the holds involved; refuse at
 * or after closes_at by the database clock, below the next minimum, without an authorized hold,
 * or past the hold; then let rival limits answer. Raising your own leading bid is allowed: the
 * lot's commitment becomes the new amount.
 */
export async function placeBid(
  paddleId: string,
  lotId: string,
  amountCents: Cents,
  source: ManualBidSource = "guest",
  options: EngineOptions = {},
): Promise<PlaceBidResult> {
  assertCents(amountCents, "amountCents");
  if (!(MANUAL_BID_SOURCES as readonly string[]).includes(source)) {
    throw new EngineError("invalid_input", `placeBid takes a manual source, not ${String(source)}`);
  }
  return withWorkspace(options, paddleId, [lotId], { budget: true }, (workspace) => {
    const placed = workspace.placeBid(paddleId, lotId, amountCents, source);
    if (!placed.ok) return placed;
    return {
      ok: true,
      bid: placed.bid,
      proxyBids: workspace.placedBids().filter((bid) => bid.id !== placed.bid.id),
      lot: workspace.lotView(lotId),
      leading: workspace.isLeading(paddleId, lotId),
    };
  });
}

export type SetMaxBidResult = Outcome<{
  limit: LimitView;
  /** Bids placed by the new max and by the rivals it set off, in order. */
  bids: PlacedBid[];
  lot: LotView;
  leading: boolean;
}>;

/**
 * "Max…" on the lot page: a guest max the engine bids up to by the minimum raise. It reserves
 * the whole max against the hold at once, and bids right away when the guest is not leading.
 */
export async function setMaxBid(
  paddleId: string,
  lotId: string,
  maxCents: Cents,
  options: EngineOptions = {},
): Promise<SetMaxBidResult> {
  assertCents(maxCents, "maxCents");
  return withWorkspace(options, paddleId, [lotId], { budget: true }, (workspace) => {
    const set = workspace.setLimit({ paddleId, lotId, maxCents, owner: "guest_max", planItemId: null });
    if (!set.ok) return set;
    const overspend = workspace.checkWithinHold(paddleId, [lotId]);
    if (overspend) return refused(overspend);
    workspace.settle(lotId);
    return {
      ok: true,
      limit: workspace.limitView(set.limitId),
      bids: workspace.placedBids(),
      lot: workspace.lotView(lotId),
      leading: workspace.isLeading(paddleId, lotId),
    };
  });
}

export interface LimitRequest {
  lotId: string;
  maxCents: Cents;
  planItemId?: string | null;
}

export interface CreateLimitsOptions extends EngineOptions {
  /** Defaults to glim. */
  owner?: LimitOwner;
  /** Lots whose limits of this owner end in the same transaction, for a plan edit that drops lots. */
  removeLotIds?: readonly string[];
}

export type CreateLimitsResult = Outcome<{
  limits: LimitView[];
  /** Opening bids and the responses they set off, in item order. */
  bids: PlacedBid[];
  lots: LotView[];
}>;

/**
 * The limits of a confirmed Glim plan, all or none: every lot must take bids, every max must
 * reach its lot's next minimum, and the paddle's commitments with every max reserved must fit the
 * hold. Then each new limit places its opening bid where the paddle is not already leading.
 * Checks run in that order across all items, so the refusal never depends on item order beyond
 * which lot it names (the first failing one, in the order given).
 */
export async function createLimits(
  paddleId: string,
  items: readonly LimitRequest[],
  options: CreateLimitsOptions = {},
): Promise<CreateLimitsResult> {
  const owner = options.owner ?? "glim";
  const removeLotIds = sortedUnique(options.removeLotIds ?? []);
  const lotIds = items.map((item) => item.lotId);
  if (items.length === 0) throw new EngineError("invalid_input", "createLimits needs at least one item");
  if (new Set(lotIds).size !== lotIds.length) {
    throw new EngineError("invalid_input", "createLimits got the same lot twice");
  }
  if (removeLotIds.some((lotId) => lotIds.includes(lotId))) {
    throw new EngineError("invalid_input", "createLimits cannot both set and remove a lot's limit");
  }
  for (const item of items) assertCents(item.maxCents, "maxCents");

  return withWorkspace(options, paddleId, [...lotIds, ...removeLotIds], { budget: true }, (workspace) => {
    for (const lotId of lotIds) {
      const gate = biddingGate(workspace.lot(lotId));
      if (gate) return refused(gate);
    }
    for (const lotId of removeLotIds) workspace.removeLimit(paddleId, lotId, owner);
    const limitIds: string[] = [];
    for (const item of items) {
      const set = workspace.setLimit({
        paddleId,
        lotId: item.lotId,
        maxCents: item.maxCents,
        owner,
        planItemId: item.planItemId ?? null,
      });
      if (!set.ok) return set;
      limitIds.push(set.limitId);
    }
    const overspend = workspace.checkWithinHold(paddleId, lotIds);
    if (overspend) return refused(overspend);
    for (const lotId of lotIds) workspace.settle(lotId);
    return {
      ok: true,
      limits: limitIds.map((limitId) => workspace.limitView(limitId)),
      bids: workspace.placedBids(),
      lots: lotIds.map((lotId) => workspace.lotView(lotId)),
    };
  });
}

export interface OwnerOptions extends EngineOptions {
  owner?: LimitOwner;
}

/**
 * Ends the paddle's active limit on a lot ("Skip the spa"); bids already placed stand. With
 * `owner`, only a limit of that owner is removed. Never refused: removing only frees hold.
 */
export async function removeLimit(
  paddleId: string,
  lotId: string,
  options: OwnerOptions = {},
): Promise<{ ok: true; removed: LimitView | null }> {
  return withWorkspace(options, paddleId, [lotId], { budget: false }, (workspace) => ({
    ok: true as const,
    removed: workspace.removeLimit(paddleId, lotId, options.owner ?? null),
  }));
}

/** Glim's Pause: its limits stop bidding but keep their hold reserved. Owner defaults to glim. */
export async function pauseLimits(
  paddleId: string,
  options: OwnerOptions = {},
): Promise<{ ok: true; limitIds: string[] }> {
  const owner = options.owner ?? "glim";
  return withWorkspace(
    options,
    paddleId,
    (tx) => tx.activeLimitLotIds(paddleId, owner),
    { budget: false },
    (workspace) => ({ ok: true as const, limitIds: workspace.pauseLimits(paddleId, owner) }),
  );
}

/** Glim's Resume: its limits bid again, starting with any bid they missed while paused. */
export async function resumeLimits(
  paddleId: string,
  options: OwnerOptions = {},
): Promise<{ ok: true; limitIds: string[]; bids: PlacedBid[] }> {
  const owner = options.owner ?? "glim";
  return withWorkspace(
    options,
    paddleId,
    (tx) => tx.activeLimitLotIds(paddleId, owner),
    { budget: true },
    (workspace) => {
      const limitIds = workspace.resumeLimits(paddleId, owner);
      return { ok: true as const, limitIds, bids: workspace.placedBids() };
    },
  );
}

/** Thrown inside the transaction so a refusal rolls back, then unwrapped into the return value. */
class RefusalRollback extends Error {
  constructor(readonly outcome: unknown) {
    super("refused");
  }
}

type LotIdSource = readonly string[] | ((tx: EngineTx) => Promise<string[]>);

async function withWorkspace<Result extends { ok: boolean }>(
  options: EngineOptions,
  paddleId: string,
  lotIds: LotIdSource,
  { budget }: { budget: boolean },
  act: (workspace: AuctionWorkspace) => Result,
): Promise<Result> {
  try {
    return await resolveStore(options).transaction(async (tx) => {
      const ids = typeof lotIds === "function" ? await lotIds(tx) : lotIds;
      const workspace = await loadWorkspace(tx, paddleId, ids, budget);
      const result = act(workspace);
      if (!result.ok) throw new RefusalRollback(result);
      await tx.apply(workspace.changes());
      return result;
    });
  } catch (error) {
    if (error instanceof RefusalRollback) return error.outcome as Result;
    throw error;
  }
}

/**
 * Locks and reads what an action needs, in the global lock order: the lots, then (when the
 * action can raise commitments) the paddle rows and authorized holds of the actor and of every
 * paddle with a limit on those lots. Commitments are read after those locks, so neither a
 * concurrent action of those paddles nor a hold swap can change them before commit.
 */
async function loadWorkspace(
  tx: EngineTx,
  paddleId: string,
  requestedLotIds: readonly string[],
  budget: boolean,
): Promise<AuctionWorkspace> {
  const [actor] = await tx.findPaddles([paddleId]);
  if (!actor) throw new EngineError("paddle_not_found", `No paddle ${paddleId}`);

  const lotIds = sortedUnique(requestedLotIds);
  const lots = lotIds.length > 0 ? await tx.lockLots(lotIds) : [];
  if (lots.length !== lotIds.length) {
    const found = new Set(lots.map((lot) => lot.id));
    throw new EngineError("lot_not_found", `No lot ${lotIds.find((id) => !found.has(id))}`);
  }
  const foreign = lots.find((lot) => lot.eventId !== actor.eventId);
  if (foreign) throw new EngineError("lot_not_in_event", `Lot ${foreign.id} is not in paddle ${paddleId}'s event`);

  const limits = lotIds.length > 0 ? await tx.activeLimitsOnLots(lotIds) : [];
  const involved = sortedUnique([actor.id, ...limits.map((limit) => limit.paddleId)]);
  const paddles = involved.length > 1 ? await tx.findPaddles(involved) : [actor];
  if (!budget) {
    return new AuctionWorkspace({ lots, limits, holds: [], paddles, commitments: [] }, () => tx.newId());
  }
  const holds = await tx.lockAuthorizedHolds(involved);
  const commitments = await tx.commitments(involved);
  return new AuctionWorkspace({ lots, limits, holds, paddles, commitments }, () => tx.newId());
}
