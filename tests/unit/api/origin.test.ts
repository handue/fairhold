import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, assertSameOrigin, isSameOrigin, publicOrigin } from "@/server/api";

const request = (headers: Record<string, string>, url = "https://fairhold.example/api/demo") =>
  new Request(url, { method: "POST", headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isSameOrigin", () => {
  it("accepts a page of this site", () => {
    expect(isSameOrigin(request({ origin: "https://fairhold.example", "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("accepts it behind a proxy, where request.url names the internal host", () => {
    const internal = "http://localhost:10000/api/demo";
    expect(isSameOrigin(request({ origin: "https://fairhold.onrender.com", "x-forwarded-host": "fairhold.onrender.com" }, internal))).toBe(true);
    expect(isSameOrigin(request({ origin: "https://fairhold.onrender.com", host: "fairhold.onrender.com" }, internal))).toBe(true);
  });

  it("accepts the local dev server, port included", () => {
    expect(isSameOrigin(request({ origin: "http://localhost:3000", host: "localhost:3000" }, "http://localhost:3000/api/demo"))).toBe(true);
  });

  it("refuses another site", () => {
    expect(isSameOrigin(request({ origin: "https://evil.example" }))).toBe(false);
    expect(isSameOrigin(request({ origin: "https://fairhold.example.evil.example" }))).toBe(false);
    expect(isSameOrigin(request({ origin: "https://fairhold.example:8443" }))).toBe(false);
  });

  it("refuses by Sec-Fetch-Site even when Origin is missing", () => {
    expect(isSameOrigin(request({ "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(isSameOrigin(request({ "sec-fetch-site": "same-site" }))).toBe(false);
  });

  it('refuses Origin "null" from a sandboxed frame', () => {
    expect(isSameOrigin(request({ origin: "null" }))).toBe(false);
  });

  it("lets a non-browser client through: no Origin and no Sec-Fetch-Site means no ambient session", () => {
    expect(isSameOrigin(request({}))).toBe(true);
  });

  it("assertSameOrigin throws a 403", () => {
    expect(() => assertSameOrigin(request({ origin: "https://evil.example" }))).toThrow(ApiError);
    expect(() => assertSameOrigin(request({ origin: "https://fairhold.example" }))).not.toThrow();
  });
});

describe("publicOrigin", () => {
  it("prefers what Render says about itself over anything a client sends", () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "https://fairhold.onrender.com/");
    expect(publicOrigin(request({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" }))).toBe("https://fairhold.onrender.com");
  });

  it("reads the forwarded headers elsewhere", () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    expect(publicOrigin(request({ "x-forwarded-host": "localhost:3000", "x-forwarded-proto": "http" }, "http://0.0.0.0:3000/x"))).toBe("http://localhost:3000");
  });

  it("falls back to the request's own URL", () => {
    vi.stubEnv("RENDER_EXTERNAL_URL", "");
    expect(publicOrigin(request({}))).toBe("https://fairhold.example");
  });
});
