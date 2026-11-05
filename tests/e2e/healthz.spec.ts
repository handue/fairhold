import { expect, test } from "@playwright/test";

test("health check reports a reachable database", async ({ request }) => {
  const response = await request.get("/api/healthz");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
