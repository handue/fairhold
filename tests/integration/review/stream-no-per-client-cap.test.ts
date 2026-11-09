/**
 * Review finding (wave 2): /api/stream needs no session and has one limit, 1,000 streams per process.
 * One client on one known slug can take all of them. Everyone else then gets 503 and falls back to
 * polling, and each stream it does not read may buffer up to 1 MiB, against a 512 MB Render plan. The
 * brake here is generous: no client should need 30 streams on one event. Until the fix, this fails.
 */
import { afterAll, describe, expect, it } from "vitest";

import { GET as streamRoute } from "@/app/api/stream/route";
import { closeStreamHub } from "@/server/sse/hub";

import { getTestDatabase } from "../../helpers/database";
import { createEvent } from "../engine/support/fixtures";

const { pool } = getTestDatabase();
const ORIGIN = "https://fairhold.example";
const BROWSER_TABS_NOBODY_NEEDS = 30;

afterAll(async () => {
  await closeStreamHub();
});

describe("streams from one client", () => {
  it("are braked well before the process's limit", async () => {
    const eventId = await createEvent(pool);
    const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
    const slug = rows[0]?.slug ?? "";

    const controllers: AbortController[] = [];
    const statuses: number[] = [];
    try {
      for (let index = 0; index < BROWSER_TABS_NOBODY_NEEDS; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        const response = await streamRoute(
          new Request(`${ORIGIN}/api/stream?slug=${slug}`, {
            headers: { "x-forwarded-for": "203.0.113.77" },
            signal: controller.signal,
          }),
          undefined,
        );
        statuses.push(response.status);
      }
    } finally {
      for (const controller of controllers) controller.abort();
    }

    expect(statuses.some((status) => status === 429 || status === 503)).toBe(true);
  });
});
