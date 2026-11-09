/**
 * What Glim never shows a guest, whatever the model wrote: words that promise an outcome or read as
 * tax advice (the brand rule). The system prompts ask for this too, but only this check enforces it.
 * The chat reply and the autopilot's why both use it. Stems and phrases, so other forms fail as well
 * ("taxable", "guaranteeing", "write-off", "fair market value", "I'll win"). A false hit costs only a
 * template line. The checks run on the folded text, so look-alike forms ("ｔａｘ", a zero-width space
 * inside a word) fail too.
 */
const BANNED_CLAIMS = new RegExp(
  [
    String.raw`\bguarante\w*`,
    String.raw`\b(?:will|(?:i|we|you|they|it)['’ʼ]?ll|going to|gonna|sure to|bound to) win\b`,
    String.raw`\bfmv\b`,
    String.raw`\birs\b`,
    String.raw`\btax\w*`,
    String.raw`\bdeduct\w*`,
    String.raw`\bwrite[-‐‑\s]?offs?\b`,
    String.raw`\b(?:fair\s+)?market\s+value\b`,
  ].join("|"),
  "i",
);

/** Text as a guest reads it: compatibility forms folded (NFKC) and invisible format characters dropped. */
export function foldGuestText(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

export function hasBannedClaim(text: string): boolean {
  return BANNED_CLAIMS.test(foldGuestText(text));
}
