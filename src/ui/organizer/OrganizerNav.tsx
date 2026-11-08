import Link from "next/link";

import type { EventSummary } from "@/server/queries/types";
import { cn } from "@/ui/cn";
import { EventStatusPill } from "@/ui/EventNav";
import { PaddleMark } from "@/ui/PaddleMark";

/**
 * The organizer's nav on 12: 08's bar with 11's closed pill and organizer links, no bidding power,
 * and 08's user pill. "Lots" and "Bidders" stay plain text as drawn, because their pages do not
 * exist; Sheet C's design/27 removes or renames them.
 */
export function OrganizerNav({ event, organizerName }: { event: EventSummary; organizerName: string }) {
  const projector = `/e/${encodeURIComponent(event.slug)}/projector`;
  const live = event.status === "live";
  return (
    <header className="flex h-68 items-center border-b border-line px-48">
      <div className="flex items-center gap-10 text-16 font-semibold">
        <PaddleMark tone="brand" size={24} />
        {event.name}
        <EventStatusPill event={event} className="ml-14" />
      </div>

      {/* The closed pill is 29.5px narrower than the live one, so the links keep their x either way. */}
      <nav aria-label="Organizer" className={cn("flex gap-28 text-14 text-ink2", live ? "ml-56" : "ml-[85.5px]")}>
        <span aria-current="page" className="font-semibold text-ink">
          Control room
        </span>
        <span>Lots</span>
        <span>Bidders</span>
        <Link href={projector}>Projector</Link>
      </nav>

      <div className="ml-auto flex items-center gap-12">
        <div className="flex h-40 items-center gap-8 rounded-full border border-line pr-14 pl-6 text-13 font-medium whitespace-nowrap">
          <span className="flex size-28 items-center justify-center rounded-full bg-lime text-12 font-semibold text-ink">
            {organizerName.charAt(0).toUpperCase()}
          </span>
          <span>
            {organizerName} <span className="font-normal text-muted">· Organizer</span>
          </span>
        </div>
      </div>
    </header>
  );
}
