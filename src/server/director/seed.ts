/**
 * The director's randomness. It is seeded, so every demo gala runs the same script and a video take
 * can be repeated: the same bots bid at the same offsets, and the rivals keep the same delays.
 */
import { createHash } from "node:crypto";

export const DIRECTOR_SEED = "fairhold-director-1";

/** A number in [0, 1) that depends only on `key`. */
export function unitFromKey(key: string): number {
  return createHash("sha256").update(key).digest().readUIntBE(0, 6) / 2 ** 48;
}

/** A stream of numbers in [0, 1) that depends only on `key` (mulberry32). */
export function seededRandom(key: string): () => number {
  let state = createHash("sha256").update(key).digest().readUInt32BE(0);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}
