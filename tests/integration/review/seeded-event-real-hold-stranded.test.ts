/**
 * Review finding (wave 2): the plan was to seed the Riverside fixture on Render. It is not a demo and
 * has no organizer session in production. Anyone can join it at its well-known slug and approve a real
 * hold, and then nobody can charge or release that hold: the sweep only retires demos, and no route
 * makes an organizer here. The hold stays authorized until PayPal's 29 days run out. The test accepts
 * either fix: refuse the join, or release the hold a while after bidding ended. Until then, it fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST as joinRoute } from "@/app/api/events/[slug]/join/route";
import { POST as holdRoute } from "@/app/api/holds/[slug]/route";
import { GET as returnRoute } from "@/app/paypal/return/route";
import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { runSweep } from "@/server/director/sweep";
import { closeEvent } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";
import { cookieFrom, postJson } from "../api/support";

const { pool } = getTestDatabase();

afterEach(() => vi.unstubAllEnvs());

describe("a stranger on the seeded event, in production", () => {
  it("does not leave a real hold that nobody can ever release", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { event } = await createFixtureEvent({}, pool);

    const joined = await joinRoute(postJson(`/api/events/${FIXTURE_SLUG}/join`, { firstName: "Stranger" }, { "x-forwarded-for": "203.0.113.9" }), {
      params: Promise.resolve({ slug: FIXTURE_SLUG }),
    });
    if (joined.status >= 400) return; // Refusing the join is one way to fix it.
    expect(joined.status).toBe(201);

    const opened = await holdRoute(postJson(`/api/holds/${FIXTURE_SLUG}`, { amountCents: 50_000 }, { cookie: cookieFrom(joined) }), {
      params: Promise.resolve({ slug: FIXTURE_SLUG }),
    });
    expect(opened.status).toBe(201);
    const { holdId, approvalUrl } = (await opened.json()) as { holdId: string; approvalUrl: string };
    expect((await returnRoute(new Request(approvalUrl))).status).toBe(200);

    // Bidding ended a week ago, and no organizer exists to charge.
    await closeEvent(event.id, { pool });
    await pool.query("update events set closes_at = now() - interval '7 days', closed_at = now() - interval '7 days' where id = $1", [event.id]);
    await runSweep({ pool });

    const { rows } = await pool.query<{ status: string }>("select status from holds where id = $1", [holdId]);
    expect(rows[0]?.status).toBe("voided");
  });
});
