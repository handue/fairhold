/**
 * Where a request came from and where it was sent. Behind Render's proxy `request.url` can name the
 * internal host, so both read the forwarded headers; Next fills x-forwarded-host and
 * x-forwarded-proto from the socket when no proxy set them.
 */
import { ApiError } from "./errors";

const firstValue = (header: string | null) => header?.split(",")[0]?.trim() || null;

function hostsOf(request: Request): Set<string> {
  const hosts = [
    firstValue(request.headers.get("x-forwarded-host")),
    firstValue(request.headers.get("host")),
    new URL(request.url).host,
  ];
  return new Set(hosts.filter((host): host is string => Boolean(host)).map((host) => host.toLowerCase()));
}

/**
 * False for a request a browser sent from another site. A browser always sends Origin on a POST
 * and, except for old ones, Sec-Fetch-Site. A request with neither is not from a browser, so it
 * carries no ambient session to abuse (monitoring and curl come this way).
 */
export function isSameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;

  const origin = request.headers.get("origin");
  if (origin === null) return true;
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    // "null" from a sandboxed frame, or anything else that is not a URL.
    return false;
  }
  return hostsOf(request).has(host);
}

/** Throws a 403 for a cross-site request. postRoute calls it first. */
export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) {
    throw new ApiError(403, "cross_origin", "This request came from another site.");
  }
}

/**
 * The site's public origin with no trailing slash, e.g. for PayPal's return_url. Render names it in
 * RENDER_EXTERNAL_URL, which no client can influence; elsewhere it comes from the request.
 */
export function publicOrigin(request: Request): string {
  const configured = process.env.RENDER_EXTERNAL_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const url = new URL(request.url);
  const proto = firstValue(request.headers.get("x-forwarded-proto")) ?? url.protocol.replace(":", "");
  const host = firstValue(request.headers.get("x-forwarded-host")) ?? firstValue(request.headers.get("host")) ?? url.host;
  return `${proto}://${host}`;
}
