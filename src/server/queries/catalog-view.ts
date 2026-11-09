import { toEventSummary } from "./event";
import type {
  CatalogLot,
  CatalogView,
  EventRecord,
  Instant,
  LotCategory,
  LotRecord,
  PaddleRecord,
  ViewerLotRecord,
} from "./types";
import { indexViewerLots, summarizeViewer, viewerLotStatus, type ViewerLots } from "./viewer-summary";

/** Screen 08's rows: all it takes to build the view, on the server and again in the browser. */
export interface CatalogInputs {
  now: Instant;
  event: EventRecord;
  lots: readonly LotRecord[];
  paddle: PaddleRecord | null;
  viewerLots: readonly ViewerLotRecord[];
  category: LotCategory | null;
}

export function buildCatalogView({ now, event, lots, paddle, viewerLots, category }: CatalogInputs): CatalogView {
  const relations = indexViewerLots(viewerLots);
  const ranked = lots
    .filter((lot) => category === null || lot.category === category)
    .map((lot) => rankLot(lot, paddle, relations))
    .sort(byCatalogOrder);

  return {
    serverNow: now,
    event: toEventSummary(event),
    viewer: paddle ? summarizeViewer(paddle, lots, relations) : null,
    raisedCents: raisedCents(lots),
    lotCount: lots.length,
    category,
    lots: ranked.map(({ card }) => card),
  };
}

/** Leading bids on open lots plus winning amounts on closed lots. */
export function raisedCents(lots: readonly LotRecord[]): number {
  return lots.reduce(
    (sum, lot) => sum + (lot.status === "closed" ? (lot.winningCents ?? 0) : (lot.currentBidCents ?? 0)),
    0,
  );
}

interface RankedLot {
  card: CatalogLot;
  /** The viewer's lots come first: winning, then outbid, then hearted; closed lots go last, won ones first. */
  rank: number;
}

function rankLot(lot: LotRecord, paddle: PaddleRecord | null, relations: ViewerLots): RankedLot {
  const relation = relations.get(lot.id);
  const viewerStatus = paddle ? viewerLotStatus(lot, paddle.id, relation) : "none";
  const isOpen = lot.status === "open";
  const isFavorite = relation?.isFavorite ?? false;

  const card: CatalogLot = {
    number: lot.number,
    category: lot.category,
    title: lot.title,
    coverDrawing: lot.coverDrawing,
    priceCents: lot.currentBidCents ?? lot.startingBidCents,
    bidCount: lot.bidCount,
    closesAt: lot.closesAt,
    status: lot.status,
    viewerStatus,
    offerGlimWatch: isOpen && isFavorite && !relation?.hasBid && !relation?.inGlimPlan,
  };

  let rank = 3;
  if (viewerStatus === "won") rank = 4;
  else if (!isOpen) rank = 5;
  else if (viewerStatus === "winning") rank = 0;
  else if (viewerStatus === "outbid") rank = 1;
  else if (isFavorite) rank = 2;
  return { card, rank };
}

/** Within each rank, the next lot to close comes first. */
function byCatalogOrder(a: RankedLot, b: RankedLot): number {
  return a.rank - b.rank || a.card.closesAt - b.card.closesAt || a.card.number - b.card.number;
}
