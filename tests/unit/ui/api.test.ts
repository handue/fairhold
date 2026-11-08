import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClientError, apiGet, apiPost } from "@/ui/api";

const answer = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubFetch(result: Response | Error) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function caught(call: Promise<unknown>): Promise<ApiClientError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ApiClientError) return error;
    throw error;
  }
  throw new Error("the call did not fail");
}

describe("apiPost", () => {
  it("sends JSON with the session cookie and returns the answer", async () => {
    const fetchMock = stubFetch(answer(201, { slug: "gala-abc" }));
    await expect(apiPost("/api/demo", { firstName: "Sam" })).resolves.toEqual({ slug: "gala-abc" });
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/demo");
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      body: '{"firstName":"Sam"}',
      headers: { accept: "application/json", "content-type": "application/json" },
    });
  });

  it("turns the error envelope into an ApiClientError", async () => {
    stubFetch(answer(409, { error: { code: "over_bidding_power", message: "That is more than you have left.", details: { availableCents: 18_000 } } }));
    const error = await caught(apiPost("/x"));
    expect(error).toMatchObject({
      status: 409,
      code: "over_bidding_power",
      message: "That is more than you have left.",
      details: { availableCents: 18_000 },
    });
  });

  it("reports a request that never got an answer", async () => {
    stubFetch(new TypeError("fetch failed"));
    const error = await caught(apiPost("/x"));
    expect([error.status, error.code]).toEqual([0, "network_error"]);
    expect(error.message).toMatch(/connection/);
  });

  it("lets the caller's own abort through untouched", async () => {
    stubFetch(new DOMException("Aborted", "AbortError"));
    await expect(apiPost("/x")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports an answer it cannot read, whatever the status", async () => {
    stubFetch(answer(502, "<html>Bad gateway</html>"));
    expect(await caught(apiPost("/x"))).toMatchObject({ status: 502, code: "invalid_response" });
    stubFetch(answer(200, "<html>"));
    expect(await caught(apiPost("/x"))).toMatchObject({ status: 200, code: "invalid_response" });
    stubFetch(answer(500, { nope: true }));
    expect(await caught(apiPost("/x"))).toMatchObject({ status: 500, code: "invalid_response" });
  });
});

describe("apiGet", () => {
  it("reads JSON", async () => {
    const fetchMock = stubFetch(answer(200, { ok: true }));
    await expect(apiGet("/api/thing")).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", credentials: "same-origin" });
  });
});
