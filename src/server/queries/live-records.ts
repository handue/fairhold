/**
 * Keeps a page's rows current from the stream. A page reads its rows and a stream position on the
 * server; the browser folds every stream row after that position over them, then runs the same
 * buildCatalogView or buildLotDetailView the server does. Nothing about bidding is decided twice:
 * this file only says which row changes which field, and tests/integration/queries/live-fold.test.ts
 * checks on Postgres that the fold lands exactly where a fresh read does.
 *
 * Replays are safe. Every field takes the last row that touched it, in stream order, and a row the
 * page's read already included changes nothing by the time the fold reaches the end. Bid history is
 * the one list that grows, so it only takes amounts above its newest, and amounts strictly rise.
 *
 * No server imports: client components run this.
 */
import { isAfterPosition, type StreamEvent, type StreamEventOf } from "@/server/sse/types";

import { BID_HISTORY_ROWS } from "./lot-view";
import type { BidRecord, EventRecord, LotRecord, PaddleRecord, ViewerLotRecord } from "./types";

/** What a stream row can change. Both pages' rows have this shape; 05 adds its lot and bids. */
export interface LiveRecords {
  streamPosition: string;
  event: EventRecord;
  lots: readonly LotRecord[];
  paddle: PaddleRecord | null;
  viewerLots: readonly ViewerLotRecord[];
  /** 05's lot, which is also one of `lots`. */
  lot?: LotRecord;
  /** 05's latest bids, newest first. */
  bids?: readonly BidRecord[];
}

interface Draft {
  event: EventRecord;
  lots: Map<string, LotRecord>;
  paddle: PaddleRecord | null;
  viewerLots: Map<string, ViewerLotRecord>;
  historyLotId: string | null;
  bids: BidRecord[];
}

/**
 * `seed` with every row after its position applied. Returns `seed` itself when no row applies, so
 * a memoized view stays the same object. Rows must be in stream order, as the stream sends them.
 */
export function foldStreamRows<Records extends LiveRecords>(seed: Records, rows: readonly StreamEvent[]): Records {
  const relevant = rows.filter((row) => isAfterPosition(row.id, seed.streamPosition));
  const newest = relevant.at(-1);
  if (!newest) return seed;

  const draft: Draft = {
    event: seed.event,
    lots: new Map(seed.lots.map((lot) => [lot.id, lot])),
    paddle: seed.paddle,
    viewerLots: new Map(seed.viewerLots.map((relation) => [relation.lotId, relation])),
    historyLotId: seed.lot?.id ?? null,
    bids: [...(seed.bids ?? [])],
  };
  for (const row of relevant) applyRow(draft, row);

  const folded: LiveRecords = {
    streamPosition: newest.id,
    event: draft.event,
    lots: seed.lots.map((lot) => draft.lots.get(lot.id) ?? lot),
    paddle: draft.paddle,
    viewerLots: [...draft.viewerLots.values()],
  };
  if (seed.lot) folded.lot = draft.lots.get(seed.lot.id) ?? seed.lot;
  if (seed.bids) folded.bids = draft.bids;
  return { ...seed, ...folded };
}

/** Is the row on the viewer's own channel? An organizer also receives other paddles' hold rows. */
const isOwnRow = (draft: Draft, row: StreamEvent) => draft.paddle !== null && row.paddleId === draft.paddle.id;

function applyRow(draft: Draft, row: StreamEvent): void {
  switch (row.type) {
    case "bid":
    case "glim":
      applyBidNews(draft, row);
      return;
    case "lot_closed":
      applyLotClosed(draft, row);
      return;
    case "event_status":
      applyEventStatus(draft, row);
      return;
    case "hold":
      if (isOwnRow(draft, row)) applyHold(draft, row);
      return;
    case "settlement":
      return;
  }
}

function relationFor(draft: Draft, lotId: string): ViewerLotRecord {
  return draft.viewerLots.get(lotId) ?? { lotId, hasBid: false, isFavorite: false, inGlimPlan: false, limitCents: null };
}

function updateRelation(draft: Draft, lotId: string, change: Partial<ViewerLotRecord>): void {
  draft.viewerLots.set(lotId, { ...relationFor(draft, lotId), ...change });
}

function applyBidNews(draft: Draft, row: StreamEventOf<"bid"> | StreamEventOf<"glim">): void {
  const { payload } = row;
  if (payload.kind === "bids_placed") {
    const lot = draft.lots.get(payload.lotId);
    if (!lot) return;
    draft.lots.set(lot.id, {
      ...lot,
      currentBidCents: payload.currentBidCents,
      bidCount: payload.bidCount,
      highPaddleId: payload.highPaddleId,
    });
    const paddleId = draft.paddle?.id;
    if (payload.bids.some((bid) => bid.paddleId === paddleId)) updateRelation(draft, lot.id, { hasBid: true });
    if (draft.historyLotId === lot.id) prependBids(draft, row.at, payload.bids);
    return;
  }

  if (!isOwnRow(draft, row)) return;
  switch (payload.kind) {
    case "limit_set":
      updateRelation(draft, payload.lotId, {
        limitCents: payload.maxCents,
        ...(payload.owner === "glim" && payload.planItemId !== null ? { inGlimPlan: true } : {}),
      });
      return;
    case "limit_exhausted":
      updateRelation(draft, payload.lotId, { limitCents: null });
      return;
    case "limit_removed":
      updateRelation(draft, payload.lotId, {
        limitCents: null,
        ...(payload.owner === "glim" ? { inGlimPlan: false } : {}),
      });
      return;
    case "favorite_changed":
      updateRelation(draft, payload.lotId, { isFavorite: payload.isFavorite });
      return;
    default:
      return;
  }
}

function prependBids(
  draft: Draft,
  at: number,
  placed: readonly { paddleId: string; paddleNumber: number; amountCents: number }[],
): void {
  const newest = draft.bids[0]?.amountCents ?? 0;
  const fresh = placed
    .filter((bid) => bid.amountCents > newest)
    .sort((a, b) => b.amountCents - a.amountCents)
    .map((bid) => ({ paddleId: bid.paddleId, paddleNumber: bid.paddleNumber, amountCents: bid.amountCents, createdAt: at }));
  draft.bids = [...fresh, ...draft.bids].slice(0, BID_HISTORY_ROWS);
}

function applyLotClosed(draft: Draft, row: StreamEventOf<"lot_closed">): void {
  const { payload } = row;
  // lot_won and lot_lost repeat this on the paddle's channel for Glim's cards.
  if (payload.kind !== "lot_closed") return;
  const lot = draft.lots.get(payload.lotId);
  if (!lot) return;
  draft.lots.set(lot.id, {
    ...lot,
    status: "closed",
    winningPaddleId: payload.winningPaddleId,
    winningCents: payload.winningCents,
    bidCount: payload.bidCount,
    // "Close bidding now" pulls closes_at back to the moment it closed; a due lot closed after it.
    closesAt: Math.min(lot.closesAt, row.at),
  });
  // Closing ends every limit on the lot.
  if (draft.viewerLots.has(lot.id)) updateRelation(draft, lot.id, { limitCents: null });
}

function applyEventStatus(draft: Draft, row: StreamEventOf<"event_status">): void {
  const { payload } = row;
  switch (payload.kind) {
    case "event_closed":
      // "Close bidding now" ends it ahead of its schedule, and the nav says when it really closed.
      draft.event = { ...draft.event, status: payload.status, closesAt: Math.min(draft.event.closesAt, row.at) };
      return;
    case "event_settling":
    case "event_settled":
      draft.event = { ...draft.event, status: payload.status };
      return;
    case "schedule_changed":
      if (payload.closesAt !== null) draft.event = { ...draft.event, closesAt: payload.closesAt };
      for (const moved of payload.lots) {
        const lot = draft.lots.get(moved.lotId);
        if (lot) draft.lots.set(lot.id, { ...lot, closesAt: moved.closesAt });
      }
      return;
  }
}

function applyHold(draft: Draft, row: StreamEventOf<"hold">): void {
  const { paddle } = draft;
  if (!paddle) return;
  const { holdId, status, amountCents } = row.payload;
  if (status === "authorized" && amountCents !== undefined) {
    draft.paddle = { ...paddle, holdCents: amountCents, holdId };
  } else if (status !== "authorized" && holdId === paddle.holdId) {
    // The hold in place ended (captured, voided, expired, or replaced, whose new hold came first).
    draft.paddle = { ...paddle, holdCents: null, holdId: null };
  }
}
