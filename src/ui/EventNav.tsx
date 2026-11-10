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
    <header className={NAV_BAR}>
      <div className={NAV_BRAND}>
        <Link href={catalogHref(links)} className="flex items-center gap-10 max-desk:min-w-0 max-md:-my-8 max-md:py-8">
          <PaddleMark tone="brand" size={24} className="max-desk:flex-none" />
          <span className="max-desk:truncate">{event.name}</span>
        </Link>
        <span className={NAV_STATUS}>
          <EventStatusPill event={event} />
          <SandboxMarker variant="nav" whenDemo />
        </span>
      </div>

      <span aria-hidden="true" className={NAV_BREAK} />
      <nav
        aria-label={event.name}
        className={cn("flex gap-28 text-14 text-ink2", closed ? "ml-[85.5px] max-desk:ml-[69.5px]" : "ml-56 max-desk:ml-40", NAV_TABS)}
      >
        {sections.map(({ key, label, href }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={cn(isActive && "font-semibold text-ink", NAV_TAB, isActive && NAV_TAB_ACTIVE)}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      {viewer && (
        <div className="ml-auto flex items-center gap-12 max-lg:contents">
          {/* Below 1024 bidding power goes beside the tabs, and the paddle pill beside the name. */}
          <div className="contents max-lg:order-5 max-lg:ml-12 max-lg:flex max-lg:flex-none max-lg:items-center">
            {power ?? <BiddingPowerPill viewer={viewer} href={powerHref(links)} />}
          </div>
          <div className={cn("contents", NAV_PILL)}>
            <PaddlePill viewer={viewer} slug={links.slug} />
          </div>
        </div>
      )}
    </header>
  );
}

/*
 * The event navs below the approved 1440 (05, 08, 09, 10, 11 and 12 share them). Laptops keep the
 * one row with 32px gutters, and the gala's name gives way first. Below 1024 the bar wraps into two
 * rows: the paddle mark and name over the status pill (with the Sandbox demo marker beside it) and
 * the paddle pill on the right; then the links as 48px tabs, with bidding power on the right.
 * Phones use 16px gutters and the compact pills. NAV_BREAK starts the second row.
 */
/** Below 1440 the gutter follows the pages' 1344 column (32px inside it), so the paddle mark lines up with the content: 43px at 1366, 32 by 1344. */
export const NAV_BAR =
  "flex h-68 items-center border-b border-line px-48 max-desk:px-[max(32px,calc(50%-640px))] max-lg:h-auto max-lg:flex-wrap max-md:px-16";
export const NAV_BRAND =
  "flex items-center gap-10 text-16 font-semibold max-desk:min-w-0 max-lg:order-1 max-lg:flex-1 max-lg:flex-col max-lg:items-stretch max-lg:justify-center max-lg:gap-4 max-lg:py-8";
/** The status pill's wrapper, which also places the Sandbox demo marker: on the rule, or beside the pill. */
export const NAV_STATUS =
  "relative ml-14 inline-flex max-desk:flex-none max-lg:ml-0 max-lg:flex-wrap max-lg:items-center max-lg:gap-x-6 max-lg:gap-y-4 max-lg:self-start";
/** The right of the first row below 1024: the paddle or organizer pill. */
export const NAV_PILL = "max-lg:order-2 max-lg:ml-12 max-lg:flex max-lg:flex-none max-lg:items-center";
export const NAV_BREAK = "hidden max-lg:order-3 max-lg:block max-lg:basis-full";
export const NAV_TABS = "max-desk:flex-none max-lg:order-4 max-lg:mr-auto max-lg:-ml-8 max-lg:gap-12";
export const NAV_TAB = "max-lg:relative max-lg:flex max-lg:h-48 max-lg:items-center max-lg:px-8 max-lg:whitespace-nowrap";
export const NAV_TAB_ACTIVE =
  "max-lg:after:absolute max-lg:after:inset-x-8 max-lg:after:-bottom-1 max-lg:after:h-2 max-lg:after:rounded-full max-lg:after:bg-ink";

/** The status label, and its compact form for a phone, where the pill sits under the gala's name. */
function eventStatusLabel(event: EventSummary): { label: string; compact: string; live: boolean } {
  switch (event.status) {
    case "live": {
      const closes = `Closes ${formatClockTime(event.closesAt, event.timeZone)}`;
      // The lime dot on ink already says live.
      return { label: `Live · ${closes}`, compact: closes, live: true };
    }
    case "draft":
    case "scheduled": {
      const opens = `Opens ${formatWeekdayTime(event.opensAt, event.timeZone)}`;
      return { label: opens, compact: opens, live: false };
    }
    case "closed":
    case "settling":
    case "settled": {
      const time = formatClosedTime(event.closesAt, event.timeZone);
      return { label: `Closed at ${time}`, compact: `Closed ${time}`, live: false };
    }
  }
}

/**
 * Ink with a lime dot while bidding is live; quiet grey before and after. On a phone the label is
 * compact: "Closes 9:30 PM" and "Closed 9:30 PM". The label is one text run, as drawn, everywhere else.
 */
export function EventStatusPill({ event, className }: { event: EventSummary; className?: string }) {
  const { label, compact, live } = eventStatusLabel(event);
  return (
    <span
      className={cn(
        "inline-flex h-26 items-center gap-7 rounded-full px-11 font-mono text-11 tracking-status uppercase",
        live ? "bg-ink text-white" : "bg-closed text-ink2",
        "max-desk:flex-none max-desk:whitespace-nowrap",
        className,
      )}
    >
      <span className={cn("block size-7 rounded-full", live ? "bg-lime" : "bg-muted")} />
      <span className="max-md:hidden">{label}</span>
      <span className="hidden max-md:inline">{compact}</span>
    </span>
  );
}

/**
 * What is left of the hold, in lime on ink, over the whole hold. The way to 09 from every guest page.
 * On a phone the pill keeps the figures ("$180 / $500" or "Not set"); its label stays for screen readers.
 */
export function BiddingPowerPill({ viewer, href }: { viewer: ViewerSummary; href: string }) {
  return (
    <Link
      href={href}
      className="flex h-40 items-center gap-10 rounded-full bg-ink px-14 font-mono text-13 text-white max-desk:flex-none max-desk:whitespace-nowrap"
    >
      <span className="text-10.5 tracking-label text-on-ink-muted uppercase max-md:hidden">Bidding power</span>
      <span className="sr-only hidden max-md:inline">Bidding power</span>
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
      <span className="max-md:hidden">{viewer.firstName}</span>
      <span className="sr-only hidden max-md:inline">{viewer.firstName}</span>
    </>
  );
  // On a phone the pill is the paddle number alone; the name stays for screen readers.
  const className =
    "flex h-40 items-center gap-8 rounded-full border border-line pr-14 pl-6 text-13 font-medium max-desk:flex-none max-desk:whitespace-nowrap max-md:pr-6";
  if (slug === undefined) return <div className={className}>{content}</div>;
  return (
    <RoleMenu slug={slug} view="guest" className={className}>
      {content}
    </RoleMenu>
  );
}
