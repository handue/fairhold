/**
 * The session cookie and its token, without any database or framework. One browser holds one cookie
 * per event, named after the event's slug, because a session belongs to one event: starting a
 * second demo, or joining another gala, does not cost a guest their paddle in the first.
 */
import { createHmac, randomBytes } from "node:crypto";

const COOKIE_PREFIX = "fh_s_";

/** Cookie names are tokens, so anything else in a slug becomes "_". Slugs are [a-z0-9-] today. */
export function sessionCookieName(slug: string): string {
  return `${COOKIE_PREFIX}${slug.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What sessions.token_hash stores. Without SESSION_SECRET a leaked table cannot be matched to a cookie. */
export function hashSessionToken(token: string, secret: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

/** Secure everywhere but a developer's own http://localhost; `next start` runs as production. */
export function sessionCookieHeader(slug: string, token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${sessionCookieName(slug)}=${token}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The value of `name` in a Cookie request header, or null. */
export function readCookieHeader(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return null;
}
