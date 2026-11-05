/**
 * Organizer- and guest-entered labels (lot titles, first names) go into the model's context, so
 * they are reduced to one short line of plain characters. Quotes, brackets, pipes and angle
 * brackets are removed so a label can never close the quoted field or the snapshot it sits in.
 * This limits what an injected title can say; the validator and the amount guard limit what it
 * can do.
 */

const DISALLOWED = /[^\p{L}\p{M}\p{N} .,'’&:!?$%/()#+-]/gu;
const INVISIBLE_OR_BREAKING = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export const MAX_TITLE_LENGTH = 48;
export const MAX_NAME_LENGTH = 32;

export function sanitizeLabel(value: string, maxLength: number): string {
  const cleaned = value
    // Folds look-alikes such as fullwidth brackets into the ASCII forms removed below.
    .normalize("NFKC")
    .replace(INVISIBLE_OR_BREAKING, " ")
    .replace(DISALLOWED, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
}
