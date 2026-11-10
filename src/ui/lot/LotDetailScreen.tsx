"use client";

import Link from "next/link";
import { useMemo } from "react";

import type { LotDetailSeed } from "@/server/queries/lot";
import { buildLotDetailView } from "@/server/queries/lot-view";
import type { LotDetail } from "@/server/queries/types";

import { CATEGORY_LABELS } from "../categories";
import { CornerOrb, GLIM_INVITATION } from "../CornerOrb";
import { EventNav } from "../EventNav";
import { Eyebrow } from "../Eyebrow";
import { formatLotNumber, formatUsd, keepTogether } from "../format";
import { useLiveRecords, useLiveServerNow } from "../live/LiveStream";
import { catalogHref, type GuestLinks } from "../routes";
import { ServerClockProvider } from "../ServerClock";

import { powerOnLot, soldToPaddleNumber } from "./bid-card-state";
import { BidCard } from "./BidCard";
import { BidHistory } from "./BidHistory";
import { LotGallery } from "./LotGallery";

/**
 * Screen 05: one lot, its bid card backed by the guest's PayPal hold, and its bid history. Rendered
 * from the rows the server read, kept current from the stream.
 */
export function LotDetailScreen({ seed, links }: { seed: LotDetailSeed; links: GuestLinks }) {
  const records = useLiveRecords(seed);
  const view = useMemo(() => buildLotDetailView(records), [records]);
  const serverNow = useLiveServerNow(seed.now);
  const { lot } = view;
  const power = useMemo(() => powerOnLot(records, records.lot.id), [records]);
  const category = CATEGORY_LABELS[lot.category];
  const lotLabel = `Lot ${formatLotNumber(lot.number)}`;

  return (
    <ServerClockProvider serverNow={serverNow}>
      <EventNav event={view.event} viewer={view.viewer} links={links} active="lots" />

      {/*
        Below 1440 the gutters narrow, and below 1280 and 1024 the card narrows so it stays beside the
        photos. A phone has one column: the photos, then the title, the card and the history. Below
        1440 Glim's corner closes the page under the history rather than resting on the bid card's
        actions on a laptop's first screen.
      */}
      <main className="mx-auto max-w-1344 px-48 pt-22 pb-48 max-desk:px-32 max-desk:pb-0 max-md:px-16 max-md:pt-16">
        <nav aria-label="Breadcrumb" className="font-mono text-11.5 tracking-label text-muted uppercase">
          <Link href={catalogHref(links)}>Lots</Link>
          {" / "}
          <Link href={catalogHref(links, lot.category)}>{category}</Link>
          {" / "}
          <span aria-current="page">{lotLabel}</span>
        </nav>

        <div className="mt-18 grid grid-cols-[minmax(0,1fr)_468px] gap-64 max-xl:grid-cols-[minmax(0,1fr)_400px] max-xl:gap-40 max-lg:grid-cols-[minmax(0,1fr)_340px] max-lg:gap-28 max-md:mt-14 max-md:grid-cols-1 max-md:gap-20">
          <LotGallery
            slug={links.slug}
            lotNumber={lot.number}
            title={lot.title}
            photos={lot.photos}
            isFavorite={lot.isFavorite}
          />
          <div>
            <Eyebrow>
              {lotLabel} · {category}
            </Eyebrow>
            <h1 className="mt-8 text-34 leading-[1.12] font-semibold tracking-title max-xl:text-balance max-lg:text-30 max-md:text-28">{lot.title}</h1>
            <p className="mt-8 text-14 text-muted">{donationLine(lot)}</p>
            <BidCard
              lot={lot}
              event={view.event}
              power={power}
              soldTo={soldToPaddleNumber(lot, view.history)}
              viewerPaddle={view.viewer?.paddleNumber ?? null}
              links={links}
            />
            <BidHistory entries={view.history} bidCount={lot.bidCount} />
          </div>
        </div>
      </main>

      <CornerOrb bubble={GLIM_INVITATION} placement="page-end" />
    </ServerClockProvider>
  );
}

/**
 * "Donated by Pine Hollow Cabins · Estimated value $600". Where it wraps, it wraps at the separator: the
 * dot stays with the donor and "Estimated value $600" stays whole (no-break spaces, which draw as
 * spaces, so 1440's one line is as approved).
 */
function donationLine(lot: LotDetail): string {
  const donor = `Donated by ${lot.donorName}`;
  if (lot.estimatedValueCents === null) return donor;
  return `${donor}\u00a0· ${keepTogether(`Estimated value ${formatUsd(lot.estimatedValueCents)}`)}`;
}
