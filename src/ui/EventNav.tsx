import Link from "next/link";
import type { ReactNode } from "react";

import type { EventSummary, ViewerSummary } from "@/server/queries/types";

import { cn } from "./cn";
import { RoleMenu } from "./demo/RoleMenu";
import { SandboxMarker } from "./demo/SandboxMarker";
import { formatClockTime, formatClosedTime, formatPaddleNumber, formatWeekdayTime } from "./format";
import { Money } from "./Money";
import { PaddleMark } from "./PaddleMark";
import { powerHref } from "./power/power-href";
import { receiptHref } from "./receipt/receipt-href";
import { catalogHref, myPaddleHref, type GuestLinks } from "./routes";

/** "how-it-works" stays for callers that still name it; its link went with its page (design/27). */
export type GuestSection = "lots" | "paddle" | "how-it-works";

interface EventNavProps {
  event: EventSummary;
  viewer: ViewerSummary | null;
  links: GuestLinks;
  active: GuestSection;
  /** Takes the bidding power pill's place: 11's outcome ("Paid $470 · Released $30"). */
  power?: ReactNode;
}

const AFTER_CLOSE: ReadonlySet<EventSummary["status"]> = new Set(["closed", "settling", "settled"]);

/**
 * The guest nav of 05, 08, 09, 10 and 11: event brand and status, links, bidding power, paddle.
 * design/27: every link goes to a real page. Lots opens 08; My paddle opens 10, and 11 once bidding
 * has closed. "How it works" went with its page. The links keep their x when the status pill is the
 * narrower closed one. On a demo gala the Sandbox demo marker sits on the rule under the status
 * pill, and its creator's paddle pill opens the role menu (design/18).
 */
export function EventNav({ event, viewer, links, active, power }: EventNavProps) {
  const closed = AFTER_CLOSE.has(event.status);
  const sections: Array<{ key: GuestSection; label: string; href: string }> = [
    { key: "lots", label: "Lots", href: catalogHref(links) },
    { key: "paddle", label: "My paddle", href: closed ? receiptHref(links) : myPaddleHref(links) },
  ];

  return (
    <header className="flex h-68 items-center border-b border-line px-48">
      <div className="flex items-center gap-10 text-16 font-semibold">
        <Link href={catalogHref(links)} className="flex items-center gap-10">
          <PaddleMark tone="brand" size={24} />
          {event.name}
        </Link>
        <span className="relative ml-14 inline-flex">
          <EventStatusPill event={event} />
          <SandboxMarker variant="nav" whenDemo />
        </span>
      </div>

      <nav
        aria-label={event.name}
        className={cn("flex gap-28 text-14 text-ink2", closed ? "ml-[85.5px]" : "ml-56")}
      >
        {sections.map(({ key, label, href }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(isActive && "font-semibold text-ink")}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {viewer && (
        <div className="ml-auto flex items-center gap-12">
          {power ?? <BiddingPowerPill viewer={viewer} href={powerHref(links)} />}
          <PaddlePill viewer={viewer} slug={links.slug} />
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
      return { label: `Closed at ${formatClosedTime(event.closesAt, event.timeZone)}`, live: false };
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

/** What is left of the hold, in lime on ink, over the whole hold. The way to 09 from every guest page. */
export function BiddingPowerPill({ viewer, href }: { viewer: ViewerSummary; href: string }) {
  return (
    <Link href={href} className="flex h-40 items-center gap-10 rounded-full bg-ink px-14 font-mono text-13 text-white">
      <span className="text-10.5 tracking-label text-on-ink-muted uppercase">Bidding power</span>
      {viewer.holdCents === null ? (
        <b className="font-medium text-on-ink-muted">Not set</b>
      ) : (
        <b className="font-medium">
          <span className="text-lime"><Money cents={viewer.availableCents} /></span> / <Money cents={viewer.holdCents} />
        </b>
      )}
    </Link>
  );
}

/** 08's paddle pill; for a demo gala's creator it opens the role menu and demo controls. */
export function PaddlePill({ viewer, slug }: { viewer: ViewerSummary; slug?: string }) {
  const content = (
    <>
      <span className="flex size-28 items-center justify-center rounded-full bg-lime font-mono text-11 font-semibold text-ink">
        {formatPaddleNumber(viewer.paddleNumber)}
      </span>
      {viewer.firstName}
    </>
  );
  const className = "flex h-40 items-center gap-8 rounded-full border border-line pr-14 pl-6 text-13 font-medium";
  if (slug === undefined) return <div className={className}>{content}</div>;
  return (
    <RoleMenu slug={slug} view="guest" className={className}>
      {content}
    </RoleMenu>
  );
}
