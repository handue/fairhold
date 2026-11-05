import { resolveStore, type EngineOptions } from "./actions";
import { sortedUnique } from "./ids";
import { EMPTY_CHANGES, type EngineStore, type EngineTx } from "./store";
import type { ClosedLotView, LotState } from "./types";
import { AuctionWorkspace } from "./workspace";

export interface CloseDueLotsResult {
  closedLots: ClosedLotView[];
  closedEventIds: string[];
}

export interface CloseDueLotsOptions extends EngineOptions {
  /** Lots handled per call; the tick picks up the rest a second later. */
  batchSize?: number;
}

/**
 * Closes every open lot whose closes_at has passed, fixing its leading bid as the winner, then
 * closes each live event that has no open lot left. Each lot closes in its own transaction.
 * Idempotent: a lot or event already closed is left alone.
 *
 * The cutoff is the database clock, or `now` when that is earlier. A caller whose clock runs
 * ahead of the database can never close a lot that placeBid would still accept bids on.
 */
export async function closeDueLots(
  now?: Date,
  options: CloseDueLotsOptions = {},
): Promise<CloseDueLotsResult> {
  const store = resolveStore(options);
  const batchSize = options.batchSize ?? 200;
  const { dueLots, staleEventIds } = await store.transaction(async (tx) => ({
    dueLots: await tx.dueLots(now ?? null, batchSize),
    staleEventIds: await tx.liveEventsWithoutOpenLots(batchSize),
  }));

  const closedLots: ClosedLotView[] = [];
  const failures: unknown[] = [];
  for (const due of dueLots) {
    try {
      const closed = await store.transaction((tx) => closeLots(tx, [due.id], { forced: false }));
      closedLots.push(...closed);
    } catch (error) {
      failures.push(error);
    }
  }

  const closedEventIds: string[] = [];
  for (const eventId of sortedUnique([...dueLots.map((lot) => lot.eventId), ...staleEventIds])) {
    try {
      if (await closeEventIfDone(store, eventId)) closedEventIds.push(eventId);
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `closeDueLots: ${failures.length} lot or event closes failed`);
  }
  return { closedLots, closedEventIds };
}

export interface CloseEventResult {
  closedLots: ClosedLotView[];
  /** True when this call moved the event from live to closed. */
  eventClosed: boolean;
}

/**
 * "Close bidding now": closes every open lot of the event at this moment, whatever its
 * closes_at, and then the event, in one transaction. Idempotent.
 */
export async function closeEvent(eventId: string, options: EngineOptions = {}): Promise<CloseEventResult> {
  return resolveStore(options).transaction(async (tx) => {
    const closedLots = await closeLots(tx, await tx.openLotIds(eventId), { forced: true });
    const eventClosed = await markEventClosed(tx, eventId);
    return { closedLots, eventClosed };
  });
}

async function closeLots(
  tx: EngineTx,
  lotIds: readonly string[],
  { forced }: { forced: boolean },
): Promise<ClosedLotView[]> {
  if (lotIds.length === 0) return [];
  const lots = await tx.lockLots(lotIds);
  const open = lots.filter((lot) => lot.status === "open");
  if (open.length === 0) return [];

  const openIds = open.map((lot) => lot.id);
  const limits = await tx.activeLimitsOnLots(openIds);
  const bidders = await tx.lotBidders(openIds);
  const paddleIds = sortedUnique([
    ...bidders.map((bidder) => bidder.paddleId),
    ...limits.map((limit) => limit.paddleId),
    ...open.flatMap((lot) => (lot.highPaddleId === null ? [] : [lot.highPaddleId])),
  ]);
  const paddles = await tx.findPaddles(paddleIds);
  const workspace = new AuctionWorkspace({ lots: open, limits, holds: [], paddles, commitments: [] }, () =>
    tx.newId(),
  );

  const closed = open.flatMap((lot: LotState) => {
    const bidderIds = bidders.filter((bidder) => bidder.lotId === lot.id).map((bidder) => bidder.paddleId);
    const view = workspace.closeLot(lot.id, { forced, bidderIds });
    return view ? [view] : [];
  });
  if (closed.length > 0) await tx.apply(workspace.changes());
  return closed;
}

async function closeEventIfDone(store: EngineStore, eventId: string): Promise<boolean> {
  return store.transaction((tx) => markEventClosed(tx, eventId));
}

async function markEventClosed(tx: EngineTx, eventId: string): Promise<boolean> {
  const closed = await tx.closeEventIfDone(eventId);
  if (closed) {
    await tx.apply({
      ...EMPTY_CHANGES,
      events: [{ eventId, paddleId: null, payload: { kind: "event_closed", status: "closed" } }],
    });
  }
  return closed;
}
