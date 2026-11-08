/**
 * Review finding (wave 2): resetDemo retires the old gala and voids its holds before it asks for the
 * new one. With 25 demos running, the new one answers 503. The organizer then has no new gala, and the
 * closed gala they could still have charged is settled, past its expiry and gone at the next sweep.
 * Until the fix, this fails.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { POST as startDemo } from "@/app/api/demo/route";
import { POST as control } from "@/app/api/events/[slug]/demo/[action]/route";
import { sessionCookieName } from "@/server/api";
import { DEMO_LIMITS } from "@/server/demo/start";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

const { pool } = getTestDatabase();

beforeEach(async () => {
  await pool.query("delete from events; delete from rate_limits");
});

describe("Reset demo with every demo slot taken", () => {
  it("leaves a closed gala chargeable when no new gala can start", async () => {
    const started = await startDemo(postJson("/api/demo", { firstName: "Sam" }), undefined);
    const { slug } = (await started.json()) as { slug: string };
    const prefix = `${sessionCookieName(slug)}=`;
    const cookie = started.headers.getSetCookie().find((value) => value.startsWith(prefix))?.split(";")[0] ?? "";
    const call = (action: string) =>
      control(postJson(`/api/events/${slug}/demo/${action}`, {}, { cookie }), { params: Promise.resolve({ slug, action }) });

    expect((await call("close-bidding")).status).toBe(200);
    await pool.query(
      `insert into events (slug, name, charity_name, closes_at, status, is_demo)
       select 'full-' || n, 'Other gala', 'Other charity', now() + interval '20 minutes', 'live', true
       from generate_series(1, $1::int) n`,
      [DEMO_LIMITS.active],
    );

    expect((await call("reset")).status).toBe(503);

    const { rows } = await pool.query<{ status: string; expired: boolean }>(
      "select status, demo_expires_at <= now() as expired from events where slug = $1",
      [slug],
    );
    expect(rows[0]).toEqual({ status: "closed", expired: false });
  });
});
