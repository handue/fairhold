import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { getDevelopmentSwitches } from "@/server/lib/env";
import { getReceiptView, type ReceiptView } from "@/server/queries/receipt-view";
import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { receiptHref } from "@/ui/receipt/receipt-href";
import { ReceiptScreen } from "@/ui/receipt/ReceiptScreen";
import { joinHref, myPaddleHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/receipt">;

export const metadata: Metadata = { title: "Receipt" };

/** Screen 11: after bidding closes, what the guest paid or will pay, and what was released. */
export default function ReceiptPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <Receipt {...props} />
    </Suspense>
  );
}

async function Receipt({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const links = { slug, paddle: viewer.linkPaddle };
  if (viewer.paddleNumber === null) redirect(joinHref(slug, receiptHref(links)));
  // The receipt reads settlement's rows, which UI_FIXTURE's database-free pages do not have.
  if (getDevelopmentSwitches().uiFixture !== null) notFound();

  const view = await getReceiptView({ slug, paddleNumber: viewer.paddleNumber });
  if (!view) notFound();
  // While bidding is open, 10 is the guest's page.
  if (view.phase === null) redirect(myPaddleHref(links));
  return <ReceiptScreen view={view as ReceiptView} links={links} />;
}
