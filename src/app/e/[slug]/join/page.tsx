import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { eventHasEnded } from "@/server/engine/rules";
import { backHrefFor } from "@/server/paypal/window-page";
import { getGuestReadSource } from "@/server/queries/source";
import { resolveViewer } from "@/server/queries/viewer";
import { FirstNameForm } from "@/ui/entry/FirstNameForm";

type Props = PageProps<"/e/[slug]/join">;

export const metadata: Metadata = { title: "Join" };

/** Stands in for design/16b, plain and with no layout of its own, until that image is approved. */
export default function JoinPage(props: Props) {
  return (
    <Suspense>
      <Join {...props} />
    </Suspense>
  );
}

async function Join({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const event = await (await getGuestReadSource()).findEvent(slug);
  if (!event) notFound();

  const after = backHrefFor(typeof query.next === "string" ? query.next : null, slug);
  const { session } = await resolveViewer(slug, null);
  if (session?.paddleId) redirect(after);

  return (
    <main className="mx-auto max-w-1344 px-48 pt-24 pb-48">
      <h1 className="text-30 leading-40 font-semibold tracking-title">{event.name}</h1>
      {eventHasEnded(event.status) ? (
        <p className="mt-8 text-14 text-muted">Bidding has closed for this event.</p>
      ) : (
        <>
          <p className="mt-8 text-14 text-muted">Your winning bids support {event.charityName}.</p>
          <FirstNameForm
            endpoint={`/api/events/${encodeURIComponent(slug)}/join`}
            submitLabel="Get my paddle"
            next={after}
          />
        </>
      )}
    </main>
  );
}
