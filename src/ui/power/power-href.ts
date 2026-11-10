import { formatLotNumber } from "../format";
import type { GuestLinks } from "../routes";

/**
 * Screen 09; `next` is where to go after approving, a page of this event. A paddle with a hold gets
 * raise mode by itself. Links may add ?amount=600 to open on an amount, and links that mean a raise
 * may say ?raise, also ?raise=600: pass `raiseToCents` for that, in whole dollars.
 */
export function powerHref(links: GuestLinks, next: string | null = null, raiseToCents: number | null = null): string {
  const query = new URLSearchParams();
  if (links.paddle !== null) query.set("paddle", String(links.paddle));
  if (next !== null) query.set("next", next);
  if (raiseToCents !== null && raiseToCents > 0 && raiseToCents % 100 === 0) query.set("raise", String(raiseToCents / 100));
  const search = query.toString();
  const path = `/e/${encodeURIComponent(links.slug)}/power`;
  return search ? `${path}?${search}` : path;
}

/**
 * 09 with the way back to one lot, for a bid that needs bidding power first; `raiseToCents` is the new
 * total that would cover it, which 09 opens on when its rules allow.
 */
export function powerHrefForLot(links: GuestLinks, lotNumber: number, raiseToCents: number | null = null): string {
  return powerHref(links, `/e/${encodeURIComponent(links.slug)}/lots/${formatLotNumber(lotNumber)}`, raiseToCents);
}

type SearchParamValue = string | string[] | undefined;

/**
 * The amount a link asks 09 to open with, in cents. Anything else reads as no amount; the page's own
 * rules still decide whether this one can be chosen.
 */
export function parsePowerAmount(query: { amount?: SearchParamValue; raise?: SearchParamValue }): number | null {
  for (const value of [query.amount, query.raise]) {
    const single = Array.isArray(value) ? value[0] : value;
    if (single !== undefined && /^[1-9]\d{0,6}$/.test(single)) return Number(single) * 100;
  }
  return null;
}
