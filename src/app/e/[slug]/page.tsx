import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";

import { getCatalogView } from "@/server/queries/catalog";
import { DEFAULT_VIEWER_PADDLE, parseCategoryParam, parsePaddleParam } from "@/server/queries/request";
import type { LotCategory } from "@/server/queries/types";
import { CatalogScreen } from "@/ui/catalog/CatalogScreen";
import { GuestPageFallback } from "@/ui/GuestPageFallback";

type Props = PageProps<"/e/[slug]">;

// One read per request, shared by the metadata and the page.
const loadCatalog = cache((slug: string, paddleNumber: number, category: LotCategory | null) =>
  getCatalogView({ slug, paddleNumber, category }),
);

async function resolve({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const paddle = parsePaddleParam(query.paddle);
  const view = await loadCatalog(slug, paddle ?? DEFAULT_VIEWER_PADDLE, parseCategoryParam(query.category));
  return { view, links: { slug, paddle } };
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  const { view } = await resolve(props);
  return { title: view?.event.name ?? "Event not found" };
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
  const { view, links } = await resolve(props);
  if (!view) notFound();
  return <CatalogScreen view={view} links={links} />;
}
