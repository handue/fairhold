import type { BidHistoryEntry } from "@/server/queries/types";

import { Eyebrow } from "../Eyebrow";
import { formatBidCount, formatPaddleNumber } from "../format";
import { TimeAgo } from "../LiveTime";
import { Money } from "../Money";

/** The latest bids on a lot, the viewer's tagged "You", with the lot's total bid count. */
export function BidHistory({ entries, bidCount }: { entries: BidHistoryEntry[]; bidCount: number }) {
  return (
    <section aria-label="Bid history" className="mt-18">
      <div className="flex justify-between">
        <Eyebrow>Bid history</Eyebrow>
        <Eyebrow>{formatBidCount(bidCount)}</Eyebrow>
      </div>
      <ol>
        {entries.map((entry) => (
          <li
            key={entry.amountCents}
            className="grid grid-cols-[1fr_auto_auto] items-center gap-18 border-b border-line py-9 text-13"
          >
            <span className="flex items-center gap-8">
              <span className="font-mono">Paddle {formatPaddleNumber(entry.paddleNumber)}</span>
              {entry.isViewer && (
                <span className="rounded-8 bg-lime px-7 py-2 text-10.5 font-semibold text-ink">You</span>
              )}
            </span>
            <span className="font-mono">
              <Money cents={entry.amountCents} />
            </span>
            <TimeAgo at={entry.placedAt} className="text-12 text-muted" />
          </li>
        ))}
      </ol>
    </section>
  );
}
