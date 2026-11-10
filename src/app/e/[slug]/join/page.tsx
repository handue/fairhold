import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { eventHasEnded } from "@/server/engine/rules";
import { backHrefFor } from "@/server/paypal/window-page";
import { getGuestReadSource } from "@/server/queries/source";
import { resolveViewer } from "@/server/queries/viewer";
import { cn } from "@/ui/cn";
import { readDemoGala } from "@/ui/demo/demo-state";
import { SandboxMarker } from "@/ui/demo/SandboxMarker";
import { JoinForm } from "@/ui/entry/EntryForms";
import { MESSAGE_COLUMN, MESSAGE_TITLE } from "@/ui/entry/message-column";
import { SandboxBuyer } from "@/ui/entry/SandboxBuyer";
import { EventStatusPill, NAV_BAR, NAV_BRAND, NAV_STATUS } from "@/ui/EventNav";
import { EventFooter } from "@/ui/event/EventFooter";
import { HeartIcon } from "@/ui/icons";
import { PaddleMark } from "@/ui/PaddleMark";

type Props = PageProps<"/e/[slug]/join">;

export const metadata: Metadata = { title: "Join" };

/** design/16b: who invited you, one field and one action. */
export default function JoinPage(props: Props) {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-68 border-b border-line max-lg:h-71" />}>
      <Join {...props} />
    </Suspense>
  );
}

async function Join({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const source = await getGuestReadSource();
  const event = await source.findEvent(slug);
  if (!event) notFound();

  const next = typeof query.next === "string" ? query.next : null;
  const { session } = await resolveViewer(slug, null);
  if (session?.paddleId) redirect(backHrefFor(next, slug));

  const [gala, lots] = await Promise.all([readDemoGala(slug), source.listLots(event.id)]);
  const isDemo = gala.kind === "event" && gala.isDemo;

  return (
    <div className="relative min-h-screen pb-82 max-md:min-h-dvh">
      {/* 08's bar with the event's own brand and live pill: no links, bidding power or paddle yet. */}
      <header className={NAV_BAR}>
        <div className={NAV_BRAND}>
          <span className="contents max-lg:flex max-lg:min-w-0 max-lg:items-center max-lg:gap-10">
            <PaddleMark tone="brand" size={24} className="max-desk:flex-none" />
            <span className="max-desk:truncate">{event.name}</span>
          </span>
          <span className={NAV_STATUS}>
            <EventStatusPill event={event} />
            {isDemo && <SandboxMarker variant="nav" />}
          </span>
        </div>
      </header>

      <main className={cn("mx-auto flex w-880 flex-col items-center pt-120 text-center tabular-nums", MESSAGE_COLUMN, "max-lg:pt-96 max-md:pt-48")}>
        <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Silent auction</p>
        {eventHasEnded(event.status) ? (
          <>
            <h1 className={cn("mt-8 text-34 leading-40 font-semibold tracking-title", MESSAGE_TITLE)}>Bidding has closed</h1>
            <p className="mt-8 text-16 leading-24 text-ink2 max-md:text-balance">{event.name} is no longer taking bids.</p>
          </>
        ) : (
          <>
            <h1 className={cn("mt-8 text-34 leading-40 font-semibold tracking-title", MESSAGE_TITLE)}>You’re invited</h1>
            <p className="mt-8 text-16 leading-24 text-ink2 max-md:text-balance">
              Join {event.name} and bid on tonight’s {lots.length} lots.
            </p>
            <p className="mt-4 flex items-center gap-8 text-16 leading-24 whitespace-nowrap text-ink2 max-md:block max-md:whitespace-normal max-md:text-balance">
              <HeartIcon size={15} className="flex-none text-muted max-md:mr-8 max-md:inline max-md:align-[-2px]" />
              Your winning bids support {event.charityName}.
            </p>
            <JoinForm slug={slug} next={next} />
            <Suspense fallback={null}>
              <SandboxBuyer />
            </Suspense>
          </>
        )}
      </main>

      <EventFooter eventName={event.name} className="absolute right-0 bottom-32 left-0" />
    </div>
  );
}
