/** How the ledger names bidders and lots; no imports, so tests and the read model share it freely. */

/** "Jamie K."; a real guest only ever typed a first name, so no initial. */
export function bidderName(firstName: string, lastInitial: string | null): string {
  return lastInitial ? `${firstName} ${lastInitial}.` : firstName;
}

export interface LedgerLotName {
  title: string;
  shortTitle: string;
}

/**
 * 12 as approved names these two lots by their full titles even beside another lot, where every
 * other lot goes by its short title (src/server/demo/README.md, "Figures that cannot all match").
 */
const FULL_NAME_BESIDE_ANOTHER_LOT: Readonly<Record<string, string>> = {
  "Wine Tasting": "Private Wine Tasting for Six",
  "Pet Portrait": "Custom Pet Portrait",
};

/** The Lots won cell: one lot by its title, several by their short titles, in lot order. */
export function lotsWonLabel(lots: readonly LedgerLotName[]): string {
  if (lots.length === 1) return lots[0]?.title ?? "";
  return lots.map((lot) => FULL_NAME_BESIDE_ANOTHER_LOT[lot.shortTitle] ?? lot.shortTitle).join(", ");
}
