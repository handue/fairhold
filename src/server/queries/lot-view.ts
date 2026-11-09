import { nextMinimumCents as engineNextMinimumCents } from "@/server/engine/rules";

import { toEventSummary } from "./event";
import type {
  BidRecord,
  EventRecord,
  Instant,
  LotDetailView,
  LotPhoto,
  LotPhotoRecord,
  LotRecord,
  PaddleRecord,
  ViewerLotRecord,
} from "./types";
import { indexViewerLots, summarizeViewer, viewerLotStatus } from "./viewer-summary";

/** The lot page shows the two latest bids next to the total count. */
export const BID_HISTORY_ROWS = 2;

/** Screen 05's rows: all it takes to build the view, on the server and again in the browser. */
export interface LotDetailInputs {
  now: Instant;
  event: EventRecord;
  /** Every lot of the event: the nav's bidding power depends on all of them. */
  lots: readonly LotRecord[];
  lot: LotRecord;
  paddle: PaddleRecord | null;
  viewerLots: readonly ViewerLotRecord[];
  photos: readonly LotPhotoRecord[];
  bids: readonly BidRecord[];
}

export function buildLotDetailView({
  now,
  event,
  lots,
  lot,
  paddle,
  viewerLots,
  photos,
  bids,
}: LotDetailInputs): LotDetailView {
  const relations = indexViewerLots(viewerLots);
  const relation = relations.get(lot.id);

  return {
    serverNow: now,
    event: toEventSummary(event),
    viewer: paddle ? summarizeViewer(paddle, lots, relations) : null,
    lot: {
      number: lot.number,
      category: lot.category,
      title: lot.title,
      shortTitle: lot.shortTitle,
      donorName: lot.donorName,
      estimatedValueCents: lot.estimatedValueCents,
      photos: lotPhotos(lot, photos),
      currentBidCents: lot.currentBidCents,
      startingBidCents: lot.startingBidCents,
      minRaiseCents: lot.minRaiseCents,
      nextMinimumCents: nextMinimumCents(lot),
      presetCents: bidPresetsCents(lot),
      bidCount: lot.bidCount,
      closesAt: lot.closesAt,
      status: lot.status,
      viewerStatus: paddle ? viewerLotStatus(lot, paddle.id, relation) : "none",
      isFavorite: relation?.isFavorite ?? false,
      limitCents: relation?.limitCents ?? null,
    },
    history: bids.map((bid) => ({
      paddleNumber: bid.paddleNumber,
      isViewer: paddle !== null && bid.paddleId === paddle.id,
      amountCents: bid.amountCents,
      placedAt: bid.createdAt,
    })),
  };
}

type BidRules = Pick<LotRecord, "highPaddleId" | "currentBidCents" | "startingBidCents" | "minRaiseCents">;

/**
 * The engine's next minimum, so the card offers exactly what placeBid accepts: the current bid
 * plus the minimum raise, or the starting bid before anyone bids.
 */
export function nextMinimumCents(lot: BidRules): number {
  return engineNextMinimumCents(lot);
}

/** The next minimum, then one and three raises above it: $340, $360, $400 at $320 with a $20 raise. */
export function bidPresetsCents(lot: BidRules): number[] {
  const next = nextMinimumCents(lot);
  return [next, next + lot.minRaiseCents, next + 3 * lot.minRaiseCents];
}

function lotPhotos(lot: LotRecord, photos: readonly LotPhotoRecord[]): LotPhoto[] {
  if (photos.length === 0) return [{ drawing: lot.coverDrawing, alt: lot.title }];
  return photos.map((photo, index) => ({
    drawing: photo.drawing,
    alt: photo.alt ?? `${lot.title}, photo ${index + 1}`,
  }));
}
