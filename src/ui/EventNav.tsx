import Link from "next/link";

import type { EventSummary, ViewerSummary } from "@/server/queries/types";

import { cn } from "./cn";
import { formatClockTime, formatPaddleNumber, formatWeekdayTime } from "./format";
import { Money } from "./Money";
import { PaddleMark } from "./PaddleMark";
import { catalogHref, myPaddleHref, type GuestLinks } from "./routes";

export type GuestSection = "lots" | "paddle" | "how-it-works";

interface EventNavProps {
  event: EventSummary;
  viewer: ViewerSummary | null;
  links: GuestLinks;
  active: GuestSection;
}

/** The guest nav of 05, 08, 09, 10 and 11: event brand and status, links, bidding power, paddle. */
export function EventNav({ event, viewer, links, active }: EventNavProps) {
  const sections: Array<{ key: GuestSection; label: string; href: string | null }> = [
    { key: "lots", label: "Lots", href: catalogHref(links) },
    { key: "paddle", label: "My paddle", href: myPaddleHref(links) },
    // Its page (or the link's removal) still waits for design approval.
    { key: "how-it-works", label: "How it works", href: null },
  ];

  return (
    <header className="flex h-68 items-center border-b border-line px-48">
      <div className="flex items-center gap-10 text-16 font-semibold">
        <Link href={catalogHref(links)} className="flex items-center gap-10">
          <PaddleMark tone="brand" size={24} />
          {event.name}
        </Link>
        <EventStatusPill event={event} className="ml-14" />
      </div>

      <nav aria-label={event.name} className="ml-56 flex gap-28 text-14 text-ink2">
        {sections.map(({ key, label, href }) => {
          const isActive = key === active;
          const className = cn(isActive && "font-semibold text-ink");
          return href ? (
            <Link key={key} href={href} aria-current={isActive ? "page" : undefined} className={className}>
              {label}
            </Link>
          ) : (
            <span key={key} className={className}>
              {label}
            </span>
          );
        })}
      </nav>

      {viewer && (
        <div className="ml-auto flex items-center gap-12">
          <BiddingPowerPill viewer={viewer} />
          <PaddlePill viewer={viewer} />
        </div>
      )}
    </header>
  );
}

function eventStatusLabel(event: EventSummary): { label: string; live: boolean } {
  switch (event.status) {
    case "live":
      return { label: `Live · Closes ${formatClockTime(event.closesAt, event.timeZone)}`, live: true };
    case "draft":
    case "scheduled":
      return { label: `Opens ${formatWeekdayTime(event.opensAt, event.timeZone)}`, live: false };
    case "closed":
    case "settling":
    case "settled":
      return { label: `Closed at ${formatClockTime(event.closesAt, event.timeZone)}`, live: false };
  }
}

/** Ink with a lime dot while bidding is live; quiet grey before and after. */
export function EventStatusPill({ event, className }: { event: EventSummary; className?: string }) {
  const { label, live } = eventStatusLabel(event);
  return (
    <span
      className={cn(
        "inline-flex h-26 items-center gap-7 rounded-full px-11 font-mono text-11 tracking-status uppercase",
        live ? "bg-ink text-white" : "bg-closed text-ink2",
        className,
      )}
    >
      <span className={cn("block size-7 rounded-full", live ? "bg-lime" : "bg-muted")} />
      {label}
    </span>
  );
}

/** What is left of the hold, in lime on ink, over the whole hold. */
export function BiddingPowerPill({ viewer }: { viewer: ViewerSummary }) {
  return (
    <div className="flex h-40 items-center gap-10 rounded-full bg-ink px-14 font-mono text-13 text-white">
      <span className="text-10.5 tracking-label text-on-ink-muted uppercase">Bidding power</span>
      {viewer.holdCents === null ? (
        <b className="font-medium text-on-ink-muted">Not set</b>
      ) : (
        <b className="font-medium">
          <span className="text-lime"><Money cents={viewer.availableCents} /></span> / <Money cents={viewer.holdCents} />
        </b>
      )}
    </div>
  );
}

export function PaddlePill({ viewer }: { viewer: ViewerSummary }) {
  return (
    <div className="flex h-40 items-center gap-8 rounded-full border border-line pr-14 pl-6 text-13 font-medium">
      <span className="flex size-28 items-center justify-center rounded-full bg-lime font-mono text-11 font-semibold text-ink">
        {formatPaddleNumber(viewer.paddleNumber)}
      </span>
      {viewer.firstName}
    </div>
  );
}
