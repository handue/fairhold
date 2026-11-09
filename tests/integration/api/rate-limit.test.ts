import { describe, expect, it } from "vitest";

import { ApiError, enforceRateLimit, pruneRateLimits, takeRateLimit } from "@/server/api";
import { withTransaction } from "@/server/db/transaction";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();
const LIMIT = { limit: 3, windowSeconds: 3_600 };

describe("takeRateLimit", () => {
  it("counts down to the limit, then refuses and says for how long", async () => {
    const key = "test:counting";
    await expect(takeRateLimit(key, LIMIT, pool)).resolves.toEqual({ ok: true, remaining: 2 });
    await expect(takeRateLimit(key, LIMIT, pool)).resolves.toEqual({ ok: true, remaining: 1 });
    await expect(takeRateLimit(key, LIMIT, pool)).resolves.toEqual({ ok: true, remaining: 0 });
    const refused = await takeRateLimit(key, LIMIT, pool);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(3_600);
    }
  });

  it("keeps keys apart", async () => {
    await takeRateLimit("test:one", { limit: 1, windowSeconds: 3_600 }, pool);
    await expect(takeRateLimit("test:two", { limit: 1, windowSeconds: 3_600 }, pool)).resolves.toMatchObject({ ok: true });
  });

  it("starts over in the next window", async () => {
    const key = "test:window";
    await takeRateLimit(key, { limit: 1, windowSeconds: 3_600 }, pool);
    await expect(takeRateLimit(key, { limit: 1, windowSeconds: 3_600 }, pool)).resolves.toMatchObject({ ok: false });
    await pool.query("update rate_limits set window_start = window_start - interval '1 hour' where key = $1", [key]);
    await expect(takeRateLimit(key, { limit: 1, windowSeconds: 3_600 }, pool)).resolves.toEqual({ ok: true, remaining: 0 });
  });

  it("lets through exactly the limit when attempts race", async () => {
    const key = "test:race";
    const results = await Promise.all(Array.from({ length: 20 }, () => takeRateLimit(key, { limit: 5, windowSeconds: 3_600 }, pool)));
    expect(results.filter((result) => result.ok)).toHaveLength(5);
  });

  it("gives the count back when the caller's transaction rolls back", async () => {
    const key = "test:rollback";
    await expect(
      withTransaction(pool, async (client) => {
        await takeRateLimit(key, LIMIT, client);
        throw new Error("the work failed");
      }),
    ).rejects.toThrow("the work failed");
    const { rows } = await pool.query("select * from rate_limits where key = $1", [key]);
    expect(rows).toHaveLength(0);
  });
});

describe("enforceRateLimit", () => {
  it("does nothing without a key", async () => {
    await expect(enforceRateLimit(null, { limit: 0, windowSeconds: 60 }, pool)).resolves.toBeUndefined();
  });

  it("throws a 429 with Retry-After past the limit", async () => {
    const key = "test:enforce";
    await enforceRateLimit(key, { limit: 1, windowSeconds: 3_600 }, pool);
    const error = await enforceRateLimit(key, { limit: 1, windowSeconds: 3_600 }, pool).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429, code: "rate_limited" });
    const { details, headers } = error as ApiError;
    expect(headers["retry-after"]).toBe(String((details as { retryAfterSeconds: number }).retryAfterSeconds));
  });
});

describe("pruneRateLimits", () => {
  it("deletes windows more than a day old and keeps the rest", async () => {
    await takeRateLimit("test:old", LIMIT, pool);
    await takeRateLimit("test:recent", LIMIT, pool);
    await pool.query("update rate_limits set window_start = now() - interval '25 hours' where key = 'test:old'");
    await expect(pruneRateLimits(pool)).resolves.toBe(1);
    const { rows } = await pool.query<{ key: string }>("select key from rate_limits where key in ('test:old', 'test:recent')");
    expect(rows.map((row) => row.key)).toEqual(["test:recent"]);
  });
});
