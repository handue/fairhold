import Link from "next/link";

import type { LotDetail, LotDetailView } from "@/server/queries/types";

import { CATEGORY_LABELS } from "../categories";
import { CornerOrb, GLIM_INVITATION } from "../CornerOrb";
import { EventNav } from "../EventNav";
import { Eyebrow } from "../Eyebrow";
import { formatLotNumber, formatUsd } from "../format";
import { catalogHref, type GuestLinks } from "../routes";
import { ServerClockProvider } from "../ServerClock";

import { BidCard } from "./BidCard";
import { BidHistory } from "./BidHistory";
import { LotGallery } from "./LotGallery";

/** Screen 05: one lot, its bid card backed by the guest's PayPal hold, and its bid history. */
export function LotDetailScreen({ view, links }: { view: LotDetailView; links: GuestLinks }) {
  const { lot } = view;
  const category = CATEGORY_LABELS[lot.category];
  const lotLabel = `Lot ${formatLotNumber(lot.number)}`;

  return (
    <ServerClockProvider serverNow={view.serverNow}>
      <EventNav event={view.event} viewer={view.viewer} links={links} active="lots" />

      <main className="mx-auto max-w-1344 px-48 pt-22 pb-48">
        <nav aria-label="Breadcrumb" className="font-mono text-11.5 tracking-label text-muted uppercase">
          <Link href={catalogHref(links)}>Lots</Link>
          {" / "}
          <Link href={catalogHref(links, lot.category)}>{category}</Link>
          {" / "}
          <span aria-current="page">{lotLabel}</span>
        </nav>

        <div className="mt-18 grid grid-cols-[minmax(0,1fr)_468px] gap-64">
          <LotGallery lotNumber={lot.number} photos={lot.photos} isFavorite={lot.isFavorite} />
          <div>
            <Eyebrow>
              {lotLabel} · {category}
            </Eyebrow>
            <h1 className="mt-8 text-34 leading-[1.12] font-semibold tracking-title">{lot.title}</h1>
            <p className="mt-8 text-14 text-muted">{donationLine(lot)}</p>
            <BidCard lot={lot} />
            <BidHistory entries={view.history} bidCount={lot.bidCount} />
          </div>
        </div>
      </main>

      <CornerOrb bubble={GLIM_INVITATION} />
    </ServerClockProvider>
  );
}

function donationLine(lot: LotDetail): string {
  const donor = `Donated by ${lot.donorName}`;
  if (lot.estimatedValueCents === null) return donor;
  return `${donor} · Estimated value ${formatUsd(lot.estimatedValueCents)}`;
}
