import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { getInsightsView } from "@/server/settlement/insights";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { InsightsScreen } from "@/ui/organizer/InsightsScreen";
import { SHOW_INSIGHTS_LINK } from "@/ui/organizer/OrganizerNav";
import { catalogHref, joinHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/organizer/insights">;

export const metadata: Metadata = { title: "Insights" };

/** The name on the approved screens, for the seeded fixture, which has no organizer session. */
const FIXTURE_ORGANIZER = "Dana";

/** Screen 28: organizer only, as 12 is. Hidden with its nav link if Insights is cut (design/27, state 5). */
export default function InsightsPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <Insights {...props} />
    </Suspense>
  );
}

async function Insights({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  if (!SHOW_INSIGHTS_LINK) notFound();
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  if (!viewer.isOrganizer) {
    redirect(viewer.session ? catalogHref({ slug, paddle: viewer.linkPaddle }) : joinHref(slug));
  }

  const view = await getInsightsView(slug);
  if (!view) notFound();

  const organizerName = viewer.session?.organizerName ?? viewer.session?.firstName ?? FIXTURE_ORGANIZER;
  return <InsightsScreen view={view} organizerName={organizerName} />;
}
