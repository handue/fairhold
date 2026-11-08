import { randomBytes } from "node:crypto";

// Crockford-style base32 without look-alike letters, lowercase for URLs.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** An unguessable slug for a private demo gala: 80 random bits, e.g. "gala-7k2m9q4x1ce8vbnt". */
export function demoSlug(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(10);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `gala-${out}`;
}

/** The creator's IANA time zone from the browser, or the gala's own when it is not a real zone. */
export function resolveTimeZone(candidate: string | null | undefined, fallback: string): string {
  if (!candidate) return fallback;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return fallback;
  }
}

const MAX_FIRST_NAME_LENGTH = 40;

/**
 * A guest's first name as typed on the join form: trimmed, inner whitespace collapsed. Control and
 * invisible format characters are refused: the name is shown to the room and to Glim.
 */
export function normalizeFirstName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new RangeError("A first name is required");
  if (name.length > MAX_FIRST_NAME_LENGTH) {
    throw new RangeError(`A first name has at most ${MAX_FIRST_NAME_LENGTH} characters`);
  }
  if (/[\p{Cc}\p{Cf}]/u.test(name)) throw new RangeError("A first name cannot hold control characters");
  return name;
}
