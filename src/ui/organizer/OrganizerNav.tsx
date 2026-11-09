import Link from "next/link";

import type { EventSummary } from "@/server/queries/types";
import { cn } from "@/ui/cn";
import { RoleMenu } from "@/ui/demo/RoleMenu";
import { SandboxMarker } from "@/ui/demo/SandboxMarker";
import { EventStatusPill } from "@/ui/EventNav";
import { PaddleMark } from "@/ui/PaddleMark";

/**
 * Insights (design/28) behind its Tuesday gate: if it is hidden, its link goes with it (design/27,
 * state 5), so no link is left without a page.
 */
export const SHOW_INSIGHTS_LINK = true;

export type OrganizerSection = "control-room" | "insights" | "projector";

/**
 * The organizer's nav on 12: 08's bar with 11's closed pill and organizer links, no bidding power,
 * and 08's user pill. design/27: Control room opens 12, Insights opens 28, Projector opens 14; the
 * organizer lots page was cut, and "Bidders" became Insights. The links keep their x whether the
 * pill is live or closed. On a demo gala the Sandbox demo marker sits under the status pill, and
 * the organizer pill opens the role menu (design/18).
 */
export function OrganizerNav({
  event,
  organizerName,
  active = "control-room",
}: {
  event: EventSummary;
  organizerName: string;
  active?: OrganizerSection;
}) {
  const base = `/e/${encodeURIComponent(event.slug)}`;
  const live = event.status === "live";
  const links: Array<{ key: OrganizerSection; label: string; href: string }> = [
    { key: "control-room", label: "Control room", href: `${base}/organizer` },
    ...(SHOW_INSIGHTS_LINK ? [{ key: "insights" as const, label: "Insights", href: `${base}/organizer/insights` }] : []),
    { key: "projector", label: "Projector", href: `${base}/projector` },
  ];
  return (
    <header className="flex h-68 items-center border-b border-line px-48">
      <div className="flex items-center gap-10 text-16 font-semibold">
        <PaddleMark tone="brand" size={24} />
        {event.name}
        <span className="relative ml-14 inline-flex">
          <EventStatusPill event={event} />
          <SandboxMarker variant="nav" whenDemo />
        </span>
      </div>

      {/* The closed pill is 29.5px narrower than the live one, so the links keep their x either way. */}
      <nav aria-label="Organizer" className={cn("flex gap-28 text-14 text-ink2", live ? "ml-56" : "ml-[85.5px]")}>
        {links.map(({ key, label, href }) => (
          <Link
            key={key}
            href={href}
            aria-current={key === active ? "page" : undefined}
            className={cn(key === active && "font-semibold text-ink")}
          >
            {label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-12">
        <RoleMenu
          slug={event.slug}
          view="organizer"
          className="flex h-40 items-center gap-8 rounded-full border border-line pr-14 pl-6 text-13 font-medium whitespace-nowrap"
        >
          <span className="flex size-28 items-center justify-center rounded-full bg-lime text-12 font-semibold text-ink">
            {organizerName.charAt(0).toUpperCase()}
          </span>
          <span>
            {organizerName} <span className="font-normal text-muted">· Organizer</span>
          </span>
        </RoleMenu>
      </div>
    </header>
  );
}
