import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { getLedgerView } from "@/server/settlement";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { ControlRoomScreen } from "@/ui/organizer/ControlRoomScreen";
import { catalogHref, joinHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/organizer">;

export const metadata: Metadata = { title: "Control room" };

/** The name on the approved screen, for the seeded fixture, which has no organizer session. */
const FIXTURE_ORGANIZER = "Dana";

/** Screen 12: organizer only. */
export default function ControlRoomPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <ControlRoom {...props} />
    </Suspense>
  );
}

async function ControlRoom({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  if (!viewer.isOrganizer) {
    // A guest belongs on the lots; someone with no paddle yet joins first.
    redirect(viewer.session ? catalogHref({ slug, paddle: viewer.linkPaddle }) : joinHref(slug));
  }

  const view = await getLedgerView(slug);
  if (!view) notFound();

  const organizerName = viewer.session?.organizerName ?? viewer.session?.firstName ?? FIXTURE_ORGANIZER;
  return <ControlRoomScreen initial={view} organizerName={organizerName} />;
}
