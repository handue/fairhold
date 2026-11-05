import type { LotCategory } from "@/server/queries/types";

import { formatLotNumber } from "./format";

/**
 * Links between the guest pages. Until the session cookie lands, a viewer chosen with ?paddle=
 * is carried along so every link keeps showing the same paddle.
 */
export interface GuestLinks {
  slug: string;
  paddle: number | null;
}

function href(path: string, query: Record<string, string | number | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== null) search.set(key, String(value));
  }
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

const eventPath = (links: GuestLinks) => `/e/${encodeURIComponent(links.slug)}`;

export function catalogHref(links: GuestLinks, category: LotCategory | null = null): string {
  return href(eventPath(links), { paddle: links.paddle, category });
}

export function lotHref(links: GuestLinks, lotNumber: number): string {
  return href(`${eventPath(links)}/lots/${formatLotNumber(lotNumber)}`, { paddle: links.paddle });
}

export function myPaddleHref(links: GuestLinks): string {
  return href(`${eventPath(links)}/paddle`, { paddle: links.paddle });
}
