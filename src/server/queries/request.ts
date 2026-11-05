import { LOT_CATEGORIES, type LotCategory } from "./types";

/**
 * Request parsing for the guest pages. Until the session cookie lands, the viewer is chosen with
 * ?paddle= and defaults to the fixture's paddle 142.
 */
export const DEFAULT_VIEWER_PADDLE = 142;

type SearchParamValue = string | string[] | undefined;

function single(value: SearchParamValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function positiveInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,6}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

/** The ?paddle= value when it is a valid paddle number. */
export function parsePaddleParam(value: SearchParamValue): number | null {
  return positiveInteger(single(value));
}

export function parseCategoryParam(value: SearchParamValue): LotCategory | null {
  const category = single(value);
  return LOT_CATEGORIES.find((candidate) => candidate === category) ?? null;
}

/** Lot numbers in URLs may be zero-padded ("07"). */
export function parseLotNumber(value: string): number | null {
  return positiveInteger(value);
}
