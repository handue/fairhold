import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";

import { eventHasEnded } from "@/server/engine/rules";
import { getPaddleSeed } from "@/server/queries/paddle";
import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { PaddleScreen } from "@/ui/paddle/PaddleScreen";
import { powerHref } from "@/ui/power/power-href";
import { receiptHref } from "@/ui/receipt/receipt-href";
import { joinHref, myPaddleHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/paddle">;

const loadPaddle = cache((slug: string, paddleNumber: number) => getPaddleSeed({ slug, paddleNumber }));

export const metadata: Metadata = { title: "My paddle" };

/** Screen 10: the guest's hold, lots and Glim's activity while bidding is open. */
export default function MyPaddlePage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <MyPaddle {...props} />
    </Suspense>
  );
}

async function MyPaddle({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const links = { slug, paddle: viewer.linkPaddle };
  if (viewer.paddleNumber === null) redirect(joinHref(slug, myPaddleHref(links)));

  const seed = await loadPaddle(slug, viewer.paddleNumber);
  if (!seed) notFound();
  // design/27 and decision B3: after the close, My paddle is the receipt.
  if (eventHasEnded(seed.event.status)) redirect(receiptHref(links));
  // Decision B3: with no bidding power there is nothing to show yet, so 09 sets it first.
  if (seed.paddle?.holdCents == null) redirect(powerHref(links, myPaddleHref(links)));

  return <PaddleScreen seed={seed} links={links} />;
}
