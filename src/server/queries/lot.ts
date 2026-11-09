import { BID_HISTORY_ROWS, buildLotDetailView, type LotDetailInputs } from "./lot-view";
import { getGuestReadSource } from "./source";
import type { GuestReadSource, LotDetailView } from "./types";

export {
  BID_HISTORY_ROWS,
  bidPresetsCents,
  buildLotDetailView,
  nextMinimumCents,
  type LotDetailInputs,
} from "./lot-view";

export interface LotQuery {
  slug: string;
  lotNumber: number;
  /** Null for a visitor with no paddle. */
  paddleNumber: number | null;
}

/** 05's rows, and the stream position they include every row up to. */
export interface LotDetailSeed extends LotDetailInputs {
  streamPosition: string;
}

/**
 * Reads 05's rows, the position first (see getCatalogSeed). Null when the event or the lot is
 * unknown.
 */
export async function getLotDetailSeed(query: LotQuery, source?: GuestReadSource): Promise<LotDetailSeed | null> {
  const reads = source ?? (await getGuestReadSource());
  const streamPosition = (await reads.streamPosition?.(query.slug)) ?? "0";
  const event = await reads.findEvent(query.slug);
  if (!event) return null;

  const [now, lots, paddle] = await Promise.all([
    reads.currentTime(),
    reads.listLots(event.id),
    query.paddleNumber === null ? null : reads.findPaddle(event.id, query.paddleNumber),
  ]);
  const lot = lots.find((candidate) => candidate.number === query.lotNumber);
  if (!lot) return null;

  const [viewerLots, photos, bids] = await Promise.all([
    paddle ? reads.listViewerLots(event.id, paddle.id) : Promise.resolve([]),
    reads.listLotPhotos(lot.id),
    reads.listLatestBids(lot.id, BID_HISTORY_ROWS),
  ]);
  return { streamPosition, now, event, lots, lot, paddle, viewerLots, photos, bids };
}

/** Screen 05: one lot with its bid card and history. Null when the event or the lot is unknown. */
export async function getLotDetailView(query: LotQuery, source?: GuestReadSource): Promise<LotDetailView | null> {
  const seed = await getLotDetailSeed(query, source);
  return seed && buildLotDetailView(seed);
}
