import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";

import { getLotDetailView } from "@/server/queries/lot";
import { DEFAULT_VIEWER_PADDLE, parseLotNumber, parsePaddleParam } from "@/server/queries/request";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { LotDetailScreen } from "@/ui/lot/LotDetailScreen";

type Props = PageProps<"/e/[slug]/lots/[number]">;

// One read per request, shared by the metadata and the page.
const loadLot = cache((slug: string, lotNumber: number, paddleNumber: number) =>
  getLotDetailView({ slug, lotNumber, paddleNumber }),
);

async function resolve({ params, searchParams }: Props) {
  const [{ slug, number }, query] = await Promise.all([params, searchParams]);
  const lotNumber = parseLotNumber(number);
  const paddle = parsePaddleParam(query.paddle);
  const view = lotNumber === null ? null : await loadLot(slug, lotNumber, paddle ?? DEFAULT_VIEWER_PADDLE);
  return { view, links: { slug, paddle } };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { view } = await resolve(props);
  return { title: view?.lot.title ?? "Lot not found" };
}

/** Screen 05: one lot and its bid card. */
export default function LotDetailPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <LotDetail {...props} />
    </Suspense>
  );
}

async function LotDetail(props: Props) {
  const { view, links } = await resolve(props);
  if (!view) notFound();
  return <LotDetailScreen view={view} links={links} />;
}
