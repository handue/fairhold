"use client";

import { useMemo } from "react";

import type { CatalogSeed } from "@/server/queries/catalog";
import { buildCatalogView } from "@/server/queries/catalog-view";
import type { CatalogLot } from "@/server/queries/types";

import { CornerOrb, GLIM_INVITATION } from "../CornerOrb";
import { EventNav } from "../EventNav";
import { GlimBand } from "../GlimBand";
import { useLiveRecords, useLiveServerNow } from "../live/LiveStream";
import { Money } from "../Money";
import { lotHref, type GuestLinks } from "../routes";
import { ServerClockProvider } from "../ServerClock";

import { CatalogGrid } from "./CatalogGrid";
import { CategoryTabs } from "./CategoryTabs";
import { LotTile } from "./LotTile";

/** 4 columns by 2 rows: the first screen of lots ends before Glim's corner. */
const FIRST_SCREEN_LOTS = 8;

/**
 * The page's order, fixed when it was read: tiles change in place while it is open, so nothing moves
 * under the cursor when a rival bids or a lot closes. The next load ranks them afresh.
 */
function pageOrder(seed: CatalogSeed): ReadonlyMap<number, number> {
  return new Map(buildCatalogView(seed).lots.map((lot, index) => [lot.number, index]));
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

  const tile = (lot: CatalogLot) => (
    <LotTile key={lot.number} lot={lot} href={lotHref(links, lot.number)} timeZone={view.event.timeZone} />
  );
  const moreLots = lots.slice(FIRST_SCREEN_LOTS);

  return (
    <ServerClockProvider serverNow={serverNow}>
      <EventNav event={view.event} viewer={view.viewer} links={links} active="lots" />

      <main className="mx-auto max-w-1344 px-48 pt-24 pb-48">
        {view.viewer && view.viewer.holdCents !== null && <GlimBand viewer={view.viewer} />}

        <div className="mt-32 flex h-40 items-center justify-between">
          <div className="flex items-center gap-32">
            <h1 className="text-30 leading-40 font-semibold tracking-title whitespace-nowrap">Tonight’s lots</h1>
            <CategoryTabs links={links} selected={view.category} lotCount={view.lotCount} />
          </div>
          <p className="flex items-baseline gap-10 whitespace-nowrap">
            <b className="font-mono text-28 leading-40 font-medium tracking-display tabular-nums">
              <Money cents={view.raisedCents} />
            </b>
            <span className="text-14 text-muted">raised so far for {view.event.charityName}</span>
          </p>
        </div>

        <CatalogGrid
          key={view.category ?? "all"}
          firstTiles={lots.slice(0, FIRST_SCREEN_LOTS).map(tile)}
          moreTiles={moreLots.map(tile)}
          moreCount={moreLots.length}
        />
      </main>

      <CornerOrb bubble={GLIM_INVITATION} />
    </ServerClockProvider>
  );
}
