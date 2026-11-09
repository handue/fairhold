import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { getPowerView } from "@/server/holds/view";
import { backHrefFor } from "@/server/paypal/window-page";
import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { parsePowerAmount, powerHref } from "@/ui/power/power-href";
import { PowerScreen } from "@/ui/power/PowerScreen";
import { catalogHref, joinHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/power">;

export const metadata: Metadata = { title: "Bidding power" };

/** Screen 09. ?next= is where the guest goes after approving; ?amount= or ?raise= picks an amount. */
export default function BiddingPowerPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <BiddingPower {...props} />
    </Suspense>
  );
}

async function BiddingPower({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const view = await getPowerView({ slug, paddleNumber: viewer.paddleNumber });
  if (!view) notFound();

  const links = { slug, paddle: viewer.linkPaddle };
  const next = typeof query.next === "string" ? query.next : null;
  if (!view.viewer) redirect(joinHref(slug, powerHref(links, next)));

  return (
    <PowerScreen
      view={{ ...view, viewer: view.viewer }}
      links={links}
      returnHref={next === null ? catalogHref(links) : backHrefFor(next, slug)}
      initialCents={parsePowerAmount(query)}
    />
  );
}
