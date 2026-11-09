import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";

import { getLotDetailSeed } from "@/server/queries/lot";
import { parseLotNumber, parsePaddleParam } from "@/server/queries/request";
import { resolveViewer } from "@/server/queries/viewer";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { LotDetailScreen } from "@/ui/lot/LotDetailScreen";
import { joinHref, lotHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]/lots/[number]">;

// One read per request, shared by the metadata and the page.
const loadLot = cache((slug: string, lotNumber: number, paddleNumber: number | null) =>
  getLotDetailSeed({ slug, lotNumber, paddleNumber }),
);

async function resolve({ params, searchParams }: Props) {
  const [{ slug, number }, query] = await Promise.all([params, searchParams]);
  const lotNumber = parseLotNumber(number);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const seed = lotNumber === null ? null : await loadLot(slug, lotNumber, viewer.paddleNumber);
  return { seed, viewer, links: { slug, paddle: viewer.linkPaddle } };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { seed } = await resolve(props);
  return { title: seed?.lot.title ?? "Lot not found" };
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
  const { seed, viewer, links } = await resolve(props);
  if (!seed) notFound();
  if (viewer.paddleNumber === null) redirect(joinHref(links.slug, lotHref(links, seed.lot.number)));
  return <LotDetailScreen seed={seed} links={links} />;
}
