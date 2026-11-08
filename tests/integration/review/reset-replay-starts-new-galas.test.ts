/**
 * Review finding (wave 2): Reset demo can be sent again with the retired gala's session. Each extra
 * call starts another live gala, and resets pass `clientKey: null`, so none of them count against the
 * 5 demos per client per hour. A double click makes two galas; one client can fill all 25 slots.
 * Until the fix, these fail.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { POST as startDemo } from "@/app/api/demo/route";
import { POST as control } from "@/app/api/events/[slug]/demo/[action]/route";
import { sessionCookieName } from "@/server/api";
import { DEMO_LIMITS } from "@/server/demo/start";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

const { pool } = getTestDatabase();
const CLIENT = { "x-forwarded-for": "203.0.113.50" };

beforeEach(async () => {
  await pool.query("delete from events; delete from rate_limits");
});

async function startGala() {
  const response = await startDemo(postJson("/api/demo", { firstName: "Sam" }, CLIENT), undefined);
  expect(response.status).toBe(201);
  const { slug } = (await response.json()) as { slug: string };
  const prefix = `${sessionCookieName(slug)}=`;
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith(prefix))?.split(";")[0] ?? "";
  return { slug, cookie };
}

const reset = ({ slug, cookie }: { slug: string; cookie: string }) =>
  control(postJson(`/api/events/${slug}/demo/reset`, {}, { ...CLIENT, cookie }), {
    params: Promise.resolve({ slug, action: "reset" }),
  });

async function liveDemos(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "select count(*)::int as n from events where is_demo and status = 'live' and closes_at > now()",
  );
  return rows[0]?.n ?? 0;
}

describe("Reset demo sent twice", () => {
  it("leaves one live gala after a double click", async () => {
    const gala = await startGala();
    expect((await reset(gala)).status).toBe(201);

    await reset(gala);

    expect(await liveDemos()).toBe(1);
  });

  it("does not let one client past its limit by replaying the retired gala's cookie", async () => {
    const gala = await startGala();
    for (let press = 0; press <= DEMO_LIMITS.startsPerClientPerHour; press += 1) await reset(gala);

    expect(await liveDemos()).toBeLessThanOrEqual(DEMO_LIMITS.startsPerClientPerHour);
  });
});
