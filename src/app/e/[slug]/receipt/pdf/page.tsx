import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { getDevelopmentSwitches } from "@/server/lib/env";
import { getReceiptView, type ReceiptView } from "@/server/queries/receipt-view";
import { parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { receiptHref, receiptPdfHref } from "@/ui/receipt/receipt-href";
import { ReceiptPdfPage } from "@/ui/receipt/ReceiptPdf";
import { joinHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/receipt/pdf">;

// 25b: the marker stays in the title a PDF viewer shows.
export const metadata: Metadata = { title: { absolute: "Sandbox demo receipt, not a tax document" } };

/** 25b: the paid receipt as one US Letter page, which "Download PDF" prints to a file. */
export default function ReceiptPdfRoute(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <ReceiptPdf {...props} />
    </Suspense>
  );
}

async function ReceiptPdf({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const links = { slug, paddle: viewer.linkPaddle };
  if (viewer.paddleNumber === null) redirect(joinHref(slug, receiptPdfHref(links)));
  if (getDevelopmentSwitches().uiFixture !== null) notFound();

  const view = await getReceiptView({ slug, paddleNumber: viewer.paddleNumber });
  if (!view) notFound();
  // Only a guest who has paid gets this file (design/25b).
  if (view.phase !== "paid" || !view.receipt) redirect(receiptHref(links));
  return <ReceiptPdfPage view={view as ReceiptView} links={links} />;
}
