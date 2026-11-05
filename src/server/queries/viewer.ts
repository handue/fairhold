import type { LotRecord, PaddleRecord, ViewerLotRecord, ViewerLotStatus, ViewerSummary } from "./types";

export type ViewerLots = ReadonlyMap<string, ViewerLotRecord>;

export function indexViewerLots(records: readonly ViewerLotRecord[]): ViewerLots {
  return new Map(records.map((record) => [record.lotId, record]));
}

export function viewerLotStatus(lot: LotRecord, paddleId: string, relation?: ViewerLotRecord): ViewerLotStatus {
  const hasBid = relation?.hasBid ?? false;
  if (lot.status === "closed") {
    if (lot.winningPaddleId === paddleId) return "won";
    return hasBid ? "lost" : "none";
  }
  if (lot.highPaddleId === paddleId) return "winning";
  return hasBid ? "outbid" : "none";
}

/**
 * The nav's bidding power and the band's bid counts. "Available" is the display rule from the
 * scope map (hold minus leading bids and won amounts); the engine enforces the stricter
 * commitment rule, which also counts active limits at their maximum.
 */
export function summarizeViewer(
  paddle: PaddleRecord,
  lots: readonly LotRecord[],
  viewerLots: ViewerLots,
): ViewerSummary {
  let leadingCents = 0;
  let wonCents = 0;
  let winningCount = 0;
  let outbidCount = 0;

  for (const lot of lots) {
    switch (viewerLotStatus(lot, paddle.id, viewerLots.get(lot.id))) {
      case "winning":
        winningCount += 1;
        leadingCents += lot.currentBidCents ?? 0;
        break;
      case "outbid":
        outbidCount += 1;
        break;
      case "won":
        wonCents += lot.winningCents ?? 0;
        break;
      default:
        break;
    }
  }

  return {
    paddleNumber: paddle.number,
    firstName: paddle.firstName,
    holdCents: paddle.holdCents,
    availableCents: paddle.holdCents === null ? 0 : Math.max(0, paddle.holdCents - leadingCents - wonCents),
    winningCount,
    outbidCount,
  };
}
