import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { eventHasEnded } from "@/server/engine/rules";
import { backHrefFor } from "@/server/paypal/window-page";
import { getGuestReadSource } from "@/server/queries/source";
import { resolveViewer } from "@/server/queries/viewer";
import { readDemoGala } from "@/ui/demo/demo-state";
import { SandboxMarker } from "@/ui/demo/SandboxMarker";
import { JoinForm } from "@/ui/entry/EntryForms";
import { SandboxBuyer } from "@/ui/entry/SandboxBuyer";
import { EventStatusPill } from "@/ui/EventNav";
import { EventFooter } from "@/ui/event/EventFooter";
import { HeartIcon } from "@/ui/icons";
import { PaddleMark } from "@/ui/PaddleMark";

type Props = PageProps<"/e/[slug]/join">;

export const metadata: Metadata = { title: "Join" };

/** design/16b: who invited you, one field and one action. */
export default function JoinPage(props: Props) {
  return (
    <Suspense fallback={<div aria-busy="true" className="h-68 border-b border-line" />}>
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
    <div className="relative min-h-screen pb-82">
      {/* 08's bar with the event's own brand and live pill: no links, bidding power or paddle yet. */}
      <header className="flex h-68 items-center border-b border-line px-48">
        <div className="flex items-center gap-10 text-16 font-semibold">
          <PaddleMark tone="brand" size={24} />
          {event.name}
          <span className="relative ml-14 inline-flex">
            <EventStatusPill event={event} />
            {isDemo && <SandboxMarker variant="nav" />}
          </span>
        </div>
      </header>

      <main className="mx-auto flex w-880 flex-col items-center pt-120 text-center tabular-nums">
        <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Silent auction</p>
        {eventHasEnded(event.status) ? (
          <>
            <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title">Bidding has closed</h1>
            <p className="mt-8 text-16 leading-24 text-ink2">{event.name} is no longer taking bids.</p>
          </>
        ) : (
          <>
            <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title">You’re invited</h1>
            <p className="mt-8 text-16 leading-24 text-ink2">
              Join {event.name} and bid on tonight’s {lots.length} lots.
            </p>
            <p className="mt-4 flex items-center gap-8 text-16 leading-24 whitespace-nowrap text-ink2">
              <HeartIcon size={15} className="flex-none text-muted" />
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
