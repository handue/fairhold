import { buildCatalogView, type CatalogInputs } from "./catalog-view";
import { getGuestReadSource } from "./source";
import type { CatalogView, GuestReadSource, LotCategory } from "./types";

export { buildCatalogView, raisedCents, type CatalogInputs } from "./catalog-view";

export interface CatalogQuery {
  slug: string;
  /** Null for a visitor with no paddle. */
  paddleNumber: number | null;
  category: LotCategory | null;
}

/** 08's rows, and the stream position they include every row up to. */
export interface CatalogSeed extends CatalogInputs {
  streamPosition: string;
  /**
   * Paddle numbers by paddle id, for every paddle leading or holding a lot when the page was read:
   * a closed tile's "Sold to Paddle 117". The page learns later leaders from the stream's bids.
   */
  paddleNumbers: Readonly<Record<string, number>>;
}

/**
 * Reads 08's rows. The position is read first: a change that lands between the reads shows up in
 * the rows and again in the replay, which the fold absorbs, where the other order would lose it.
 * Null when the event is unknown.
 */
export async function getCatalogSeed(query: CatalogQuery, source?: GuestReadSource): Promise<CatalogSeed | null> {
  const reads = source ?? (await getGuestReadSource());
  const streamPosition = (await reads.streamPosition?.(query.slug)) ?? "0";
  const event = await reads.findEvent(query.slug);
  if (!event) return null;

  const [now, lots, paddle] = await Promise.all([
    reads.currentTime(),
    reads.listLots(event.id),
    query.paddleNumber === null ? null : reads.findPaddle(event.id, query.paddleNumber),
  ]);
  const [viewerLots, leaders] = await Promise.all([
    paddle ? reads.listViewerLots(event.id, paddle.id) : Promise.resolve([]),
    reads.listLeaderNumbers?.(event.id) ?? Promise.resolve([]),
  ]);
  const paddleNumbers = Object.fromEntries(leaders.map((leader) => [leader.paddleId, leader.number]));
  return { streamPosition, now, event, lots, paddle, viewerLots, category: query.category, paddleNumbers };
}

/** Screen 08: the event, the viewer's bidding power and every lot. Null when the event is unknown. */
export async function getCatalogView(query: CatalogQuery, source?: GuestReadSource): Promise<CatalogView | null> {
  const seed = await getCatalogSeed(query, source);
  return seed && buildCatalogView(seed);
}
