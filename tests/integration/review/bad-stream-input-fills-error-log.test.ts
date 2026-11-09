/**
 * Review finding (wave 2): two request values pass the routes' checks and then make Postgres throw, so
 * a visitor with no session gets a 500, and in production each request writes a row to error_log, which
 * nothing prunes, on a 1 GB database. parseStreamPosition lets through 19-digit numbers above bigint's
 * maximum, and a NUL in a slug is not valid text. Until the fix, these fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as joinRoute } from "@/app/api/events/[slug]/join/route";
import { GET as pollRoute } from "@/app/api/stream/poll/route";

import { getTestDatabase } from "../../helpers/database";
import { createEvent } from "../engine/support/fixtures";
import { postJson } from "../api/support";

const { pool } = getTestDatabase();
const ORIGIN = "https://fairhold.example";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function errorLogRows(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from error_log where source = 'api'");
  return rows[0]?.n ?? 0;
}

function asProduction() {
  vi.stubEnv("NODE_ENV", "production");
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("input the routes let through to Postgres", () => {
  it("a stream position past bigint's maximum is not a 500", async () => {
    asProduction();
    const eventId = await createEvent(pool);
    const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
    const before = await errorLogRows();

    const response = await pollRoute(new Request(`${ORIGIN}/api/stream/poll?slug=${rows[0]?.slug}&after=9999999999999999999`), undefined);

    expect.soft(response.status).toBeLessThan(500);
    expect.soft(await errorLogRows()).toBe(before);
  });

  it("a NUL in the slug is an unknown event on the stream", async () => {
    asProduction();
    const before = await errorLogRows();

    const response = await pollRoute(new Request(`${ORIGIN}/api/stream/poll?slug=%00`), undefined);

    expect.soft(response.status).toBe(404);
    expect.soft(await errorLogRows()).toBe(before);
  });

  it("a NUL in the slug is an unknown event on join", async () => {
    asProduction();
    const before = await errorLogRows();

    const response = await joinRoute(postJson("/api/events/x/join", { firstName: "Sam" }, { "x-forwarded-for": "203.0.113.20" }), {
      params: Promise.resolve({ slug: "\u0000" }),
    });

    expect.soft(response.status).toBe(404);
    expect.soft(await errorLogRows()).toBe(before);
  });
});
