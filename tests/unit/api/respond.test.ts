import { redirect } from "next/navigation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, apiRoute, jsonOk, postRoute, readJson } from "@/server/api";

const URL_BASE = "https://fairhold.example/api/thing";

const jsonRequest = (body: string, headers: Record<string, string> = {}) =>
  new Request(URL_BASE, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

const body = z.object({ amountCents: z.number().int().positive() });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsonOk", () => {
  it("answers JSON that is never cached", async () => {
    const response = jsonOk({ ok: true }, { status: 201 });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true });
  });
});

describe("apiRoute", () => {
  it("passes the context through", async () => {
    const handler = apiRoute<{ params: string }>((_request, context) => jsonOk({ params: context.params }));
    const response = await handler(new Request(URL_BASE), { params: "gala" });
    expect(await response.json()).toEqual({ params: "gala" });
  });

  it("answers 400 for text Postgres refuses, at any depth, and reports nothing", async () => {
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const refused = Object.assign(new Error("invalid byte sequence"), { code: "22021" });
    for (const error of [refused, new Error("wrapped by the ORM", { cause: refused })]) {
      const handler = apiRoute(() => {
        throw error;
      });
      const response = await handler(new Request(URL_BASE), undefined);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect(report).not.toHaveBeenCalled();
  });

  it("turns an ApiError into the envelope", async () => {
    const handler = apiRoute(() => {
      throw new ApiError(409, "over_bidding_power", "That is more than you have left.", { availableCents: 18_000 }, { "x-test": "1" });
    });
    const response = await handler(new Request(URL_BASE), undefined);
    expect(response.status).toBe(409);
    expect(response.headers.get("x-test")).toBe("1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: { code: "over_bidding_power", message: "That is more than you have left.", details: { availableCents: 18_000 } },
    });
  });

  it("gives details null when there are none", async () => {
    const handler = apiRoute(() => {
      throw new ApiError(404, "event_not_found", "We could not find this event.");
    });
    const response = await handler(new Request(URL_BASE), undefined);
    expect(await response.json()).toEqual({ error: { code: "event_not_found", message: "We could not find this event.", details: null } });
  });

  it("answers an unknown failure with a 500 that says nothing about the cause", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = apiRoute(() => {
      throw new Error("password=hunter2 at db.internal");
    });
    const response = await handler(new Request(`${URL_BASE}?token=SECRET`), undefined);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("hunter2");
    expect(JSON.parse(text)).toEqual({
      error: { code: "internal_error", message: "Something went wrong. Please try again.", details: null },
    });
    // The log names the path, never the query string.
    expect(logged.mock.calls[0]?.[0]).toBe("[api] GET /api/thing failed:");
  });

  it("does not swallow Next's own control flow", async () => {
    const handler = apiRoute(() => redirect("/elsewhere"));
    await expect(Promise.resolve().then(() => handler(new Request(URL_BASE), undefined))).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("postRoute", () => {
  it("runs the handler for a same-origin request", async () => {
    const handler = postRoute(() => jsonOk({ ok: true }));
    const response = await handler(new Request(URL_BASE, { method: "POST", headers: { origin: "https://fairhold.example" } }), undefined);
    expect(response.status).toBe(200);
  });

  it("refuses a cross-site request before the handler runs", async () => {
    const run = vi.fn(() => jsonOk({ ok: true }));
    const handler = postRoute(run);
    const response = await handler(new Request(URL_BASE, { method: "POST", headers: { origin: "https://evil.example" } }), undefined);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "cross_origin" } });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("readJson", () => {
  const failure = async (request: Request) => {
    try {
      await readJson(request, body, { maxBytes: 64 });
    } catch (error) {
      if (error instanceof ApiError) return error;
      throw error;
    }
    throw new Error("readJson accepted the request");
  };

  it("returns the parsed body", async () => {
    await expect(readJson(jsonRequest('{"amountCents":32000}'), body)).resolves.toEqual({ amountCents: 32_000 });
  });

  it("accepts a charset on the content type", async () => {
    const request = jsonRequest('{"amountCents":1}', { "content-type": "application/json; charset=utf-8" });
    await expect(readJson(request, body)).resolves.toEqual({ amountCents: 1 });
  });

  it("answers 415 for anything but JSON", async () => {
    const error = await failure(new Request(URL_BASE, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }));
    expect([error.status, error.code]).toEqual([415, "unsupported_media_type"]);
  });

  it("answers 400 for JSON it cannot parse", async () => {
    const error = await failure(jsonRequest("{nope"));
    expect([error.status, error.code]).toEqual([400, "invalid_json"]);
  });

  it("answers 400 naming the field, without echoing the value", async () => {
    const error = await failure(jsonRequest('{"amountCents":"not-a-number"}'));
    expect([error.status, error.code]).toEqual([400, "invalid_request"]);
    expect(JSON.stringify(error.details)).toContain("amountCents");
    expect(JSON.stringify(error.details)).not.toContain("not-a-number");
  });

  it("answers 413 from the declared length", async () => {
    const error = await failure(jsonRequest("{}", { "content-length": "65" }));
    expect([error.status, error.code]).toEqual([413, "payload_too_large"]);
  });

  it("answers 413 for a chunked body that runs past the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(40)));
      },
    });
    const request = new Request(URL_BASE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const error = await failure(request);
    expect([error.status, error.code]).toEqual([413, "payload_too_large"]);
  });
});
