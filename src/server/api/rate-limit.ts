/**
 * Fixed-window rate limits in Postgres (the rate_limits table): one atomic upsert per attempt on
 * the database clock, so a limit survives a deploy and holds across overlapping instances. Pass a
 * transaction's client to make the count part of that transaction, so a rollback gives it back.
 */
import { createHmac } from "node:crypto";

import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { getServerEnv } from "@/server/lib/env";

import { ApiError } from "./errors";

export interface RateLimit {
  limit: number;
  windowSeconds: number;
}

export type RateLimitResult = { ok: true; remaining: number } | { ok: false; retryAfterSeconds: number };

/** Counts one attempt against `key` and says whether it is within `limit` for the current window. */
export async function takeRateLimit(
  key: string,
  { limit, windowSeconds }: RateLimit,
  db: Queryable = getPool(),
): Promise<RateLimitResult> {
  const { rows } = await db.query<{ count: number; resets_in: number }>(
    `insert into rate_limits as r (key, window_start, count)
     values ($1, to_timestamp(floor(extract(epoch from now()) / $2::int) * $2::int), 1)
     on conflict (key, window_start) do update set count = r.count + 1
     returning r.count, extract(epoch from (r.window_start + make_interval(secs => $2::int) - now()))::float8 as resets_in`,
    [key, windowSeconds],
  );
  const row = rows[0];
  if (!row) throw new Error("rate_limits upsert returned no row");
  if (row.count <= limit) return { ok: true, remaining: limit - row.count };
  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(row.resets_in)) };
}

/** Throws a 429 past the limit. A null key means there is nothing to limit by (see clientRateLimitKey). */
export async function enforceRateLimit(
  key: string | null,
  limit: RateLimit,
  db: Queryable = getPool(),
  message = "Too many requests. Please try again in a little while.",
): Promise<void> {
  if (key === null) return;
  const result = await takeRateLimit(key, limit, db);
  if (result.ok) return;
  throw new ApiError(
    429,
    "rate_limited",
    message,
    { retryAfterSeconds: result.retryAfterSeconds },
    { "retry-after": String(result.retryAfterSeconds) },
  );
}

/**
 * The client's address. Behind Cloudflare the first two headers are set by the proxy, so a client
 * cannot forge them. x-forwarded-for is the fallback, and Next fills it from the socket when no
 * proxy did; a forged first address only gets someone past a per-client limit, never a global one.
 */
export function clientIp(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip") ?? request.headers.get("true-client-ip");
  if (direct?.trim()) return direct.trim();
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
}

const LOOPBACK: ReadonlySet<string> = new Set(["::1", "127.0.0.1", "::ffff:127.0.0.1"]);

/**
 * A rate-limit key for this client in `scope`, e.g. "demo:3f9a…": a keyed hash, so the table never
 * holds an address. Null on a developer's own machine, where there is one client and nothing to
 * protect; production never returns null, and clients it cannot tell apart share one bucket.
 */
export function clientRateLimitKey(request: Request, scope: string): string | null {
  const ip = clientIp(request);
  if (process.env.NODE_ENV !== "production" && (ip === null || LOOPBACK.has(ip))) return null;
  const hash = createHmac("sha256", getServerEnv().SESSION_SECRET)
    .update(ip ?? "unknown")
    .digest("hex")
    .slice(0, 32);
  return `${scope}:${hash}`;
}

/** Deletes windows that ended more than a day ago; the sweep calls it. Returns how many went. */
export async function pruneRateLimits(db: Queryable = getPool()): Promise<number> {
  const { rowCount } = await db.query("delete from rate_limits where window_start < now() - interval '1 day'");
  return rowCount ?? 0;
}
