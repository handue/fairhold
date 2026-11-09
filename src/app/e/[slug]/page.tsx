import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { cache, Suspense } from "react";

import { getCatalogSeed } from "@/server/queries/catalog";
import { parseCategoryParam, parsePaddleParam } from "@/server/queries/request";
import type { LotCategory } from "@/server/queries/types";
import { resolveViewer } from "@/server/queries/viewer";
import { CatalogScreen } from "@/ui/catalog/CatalogScreen";
import { GuestPageFallback } from "@/ui/GuestPageFallback";
import { joinHref } from "@/ui/routes";

type Props = PageProps<"/e/[slug]">;

// One read per request, shared by the metadata and the page.
const loadCatalog = cache((slug: string, paddleNumber: number | null, category: LotCategory | null) =>
  getCatalogSeed({ slug, paddleNumber, category }),
);

async function resolve({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const viewer = await resolveViewer(slug, parsePaddleParam(query.paddle));
  const seed = await loadCatalog(slug, viewer.paddleNumber, parseCategoryParam(query.category));
  return { seed, viewer, links: { slug, paddle: viewer.linkPaddle } };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { seed } = await resolve(props);
  return { title: seed?.event.name ?? "Event not found" };
}

/** Screen 08: the lots of a live event. */
export default function LotsPage(props: Props) {
  return (
    <Suspense fallback={<GuestPageFallback />}>
      <Catalog {...props} />
    </Suspense>
  );
}

async function Catalog(props: Props) {
  const { seed, viewer, links } = await resolve(props);
  if (!seed) notFound();
  if (viewer.paddleNumber === null) redirect(joinHref(links.slug));
  return <CatalogScreen seed={seed} links={links} />;
}
