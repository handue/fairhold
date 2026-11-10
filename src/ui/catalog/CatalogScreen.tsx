"use client";

import { useMemo, useState } from "react";

import { eventHasEnded } from "@/server/engine/rules";
import type { CatalogSeed } from "@/server/queries/catalog";
import { buildCatalogView } from "@/server/queries/catalog-view";
import type { CatalogLot } from "@/server/queries/types";

import { CornerOrb, GLIM_INVITATION } from "../CornerOrb";
import { EventNav } from "../EventNav";
import { formatClockTime } from "../format";
import { GlimBand } from "../GlimBand";
import { useLiveRecords, useLiveServerNow, useStreamEvent } from "../live/LiveStream";
import { wonTileLine } from "../lot/bid-card-state";
import { Money } from "../Money";
import { powerHref } from "../power/power-href";
import { receiptHref } from "../receipt/receipt-href";
import { lotHref, type GuestLinks } from "../routes";
import { ServerClockProvider } from "../ServerClock";

import { CatalogGrid } from "./CatalogGrid";
import { CategoryTabs } from "./CategoryTabs";
import { LotTile } from "./LotTile";
import { NotSetBand } from "./NotSetBand";

/** 4 columns by 2 rows: the first screen of lots ends before Glim's corner. */
const FIRST_SCREEN_LOTS = 8;

/**
 * The page's order, fixed when it was read: tiles change in place while it is open, so nothing moves
 * under the cursor when a rival bids or a lot closes. The next load ranks them afresh.
 */
function pageOrder(seed: CatalogSeed): ReadonlyMap<number, number> {
  return new Map(buildCatalogView(seed).lots.map((lot, index) => [lot.number, index]));
}

/**
 * Paddle numbers by id: the seed's, plus every bidder the stream has named since. An id's number never
 * changes, so whatever the page learns stays true.
 */
function usePaddleNumbers(seed: CatalogSeed): Readonly<Record<string, number>> {
  const [learned, setLearned] = useState<Readonly<Record<string, number>>>({});
  useStreamEvent((row) => {
    if ((row.type !== "bid" && row.type !== "glim") || row.payload.kind !== "bids_placed") return;
    const { bids, highPaddleId, highPaddleNumber } = row.payload;
    const fresh = [...bids.map((bid) => [bid.paddleId, bid.paddleNumber] as const), [highPaddleId, highPaddleNumber] as const];
    if (fresh.every(([id, number]) => learned[id] === number)) return;
    setLearned((known) => ({ ...known, ...Object.fromEntries(fresh) }));
  });
  return useMemo(() => ({ ...seed.paddleNumbers, ...learned }), [seed.paddleNumbers, learned]);
}

/** Screen 08: the guest's home for a live event. Rendered from the rows the server read, kept current from the stream. */
export function CatalogScreen({ seed, links }: { seed: CatalogSeed; links: GuestLinks }) {
  const records = useLiveRecords(seed);
  const view = useMemo(() => buildCatalogView(records), [records]);
  const order = useMemo(() => pageOrder(seed), [seed]);
  const lots = useMemo(
    () => [...view.lots].sort((a, b) => (order.get(a.number) ?? 0) - (order.get(b.number) ?? 0)),
    [view.lots, order],
  );
  const serverNow = useLiveServerNow(seed.now);
  const paddleNumbers = usePaddleNumbers(seed);
  const winners = useMemo(
    () => new Map(records.lots.map((lot) => [lot.number, lot.winningPaddleId ?? null])),
    [records.lots],
  );

  const { event, viewer } = view;
  const wonLine = wonTileLine(event.status, formatClockTime(event.closesAt, event.timeZone));
  const soldTo = (lot: CatalogLot) => {
    const winner = lot.status === "closed" ? winners.get(lot.number) : null;
    return winner ? (paddleNumbers[winner] ?? null) : null;
  };
  const tile = (lot: CatalogLot) => (
    <LotTile
      key={lot.number}
      lot={lot}
      href={lotHref(links, lot.number)}
      timeZone={event.timeZone}
      soldTo={soldTo(lot)}
      wonLine={wonLine}
    />
  );
  const rowFiller = lots[FIRST_SCREEN_LOTS];

  return (
    <ServerClockProvider serverNow={serverNow}>
      <EventNav event={event} viewer={viewer} links={links} active="lots" />

      {/*
        Below 1440 the gutters narrow, and the page leaves room at its end for the demo guide and Glim's
        corner, so the last lots scroll clear of them on a short laptop screen; below 1280 the title and
        total share a row over the tabs, and the grid is three across until the first row of the rest
        (CatalogGrid's rowFiller); on a phone the room at the bottom is Glim's corner (88px).
      */}
      <main className="mx-auto max-w-1344 px-48 pt-24 pb-48 max-desk:px-32 max-desk:pb-144 max-lg:pb-128 max-md:px-16 max-md:pt-16 max-md:pb-[calc(104px+env(safe-area-inset-bottom))]">
        {viewer && viewer.holdCents !== null && (
          <GlimBand viewer={viewer} receiptHref={eventHasEnded(event.status) ? receiptHref(links) : undefined} />
        )}
        {viewer && viewer.holdCents === null && !eventHasEnded(event.status) && <NotSetBand href={powerHref(links)} />}

        <div className="mt-32 flex h-40 items-center justify-between max-xl:grid max-xl:h-auto max-xl:grid-cols-[auto_minmax(0,1fr)] max-xl:gap-x-32 max-xl:gap-y-20 max-md:mt-24 max-md:grid-cols-1 max-md:gap-y-12">
          <div className="flex items-center gap-32 max-xl:contents">
            <h1 className="text-30 leading-40 font-semibold tracking-title whitespace-nowrap max-md:text-28 max-md:leading-36">
              Tonight’s lots
            </h1>
            <CategoryTabs links={links} selected={view.category} lotCount={view.lotCount} />
          </div>
          <p className="flex items-baseline gap-10 whitespace-nowrap max-xl:col-start-2 max-xl:row-start-1 max-xl:justify-self-end max-md:col-start-1 max-md:row-start-2 max-md:justify-self-start max-md:whitespace-normal">
            <b className="font-mono text-28 leading-40 font-medium tracking-display tabular-nums max-md:text-24 max-md:leading-30">
              <Money cents={view.raisedCents} />
            </b>
            <span className="text-14 text-muted max-md:min-w-0 max-md:text-balance">raised so far for {event.charityName}</span>
          </p>
        </div>

        <CatalogGrid
          key={view.category ?? "all"}
          firstTiles={lots.slice(0, FIRST_SCREEN_LOTS).map(tile)}
          rowFiller={rowFiller && tile(rowFiller)}
          moreTiles={lots.slice(FIRST_SCREEN_LOTS + 1).map(tile)}
          moreCount={Math.max(0, lots.length - FIRST_SCREEN_LOTS)}
        />
      </main>

      <CornerOrb bubble={GLIM_INVITATION} />
    </ServerClockProvider>
  );
}
