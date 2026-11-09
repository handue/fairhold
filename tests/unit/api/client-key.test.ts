import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIp, clientRateLimitKey } from "@/server/api";

const request = (headers: Record<string, string>) => new Request("https://fairhold.example/api/demo", { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientIp", () => {
  it("prefers the headers a client cannot forge past Cloudflare", () => {
    expect(clientIp(request({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1, 203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(request({ "true-client-ip": "203.0.113.8", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.8");
  });

  it("falls back to the first x-forwarded-for address", () => {
    expect(clientIp(request({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }))).toBe("203.0.113.7");
  });

  it("is null with nothing to go on", () => {
    expect(clientIp(request({}))).toBeNull();
  });
});

describe("clientRateLimitKey", () => {
  it("hashes the address and never contains it", () => {
    const key = clientRateLimitKey(request({ "x-forwarded-for": "203.0.113.7" }), "demo");
    expect(key).toMatch(/^demo:[0-9a-f]{32}$/);
    expect(key).not.toContain("203.0.113.7");
  });

  it("is the same for one client and differs by client and scope", () => {
    const key = (ip: string, scope = "demo") => clientRateLimitKey(request({ "x-forwarded-for": ip }), scope);
    expect(key("203.0.113.7")).toBe(key("203.0.113.7"));
    expect(key("203.0.113.7")).not.toBe(key("203.0.113.8"));
    expect(key("203.0.113.7", "join")).not.toBe(key("203.0.113.7", "demo"));
  });

  it("is null on a developer's own machine, where Next fills x-forwarded-for from the socket", () => {
    for (const ip of ["::1", "127.0.0.1", "::ffff:127.0.0.1"]) {
      expect(clientRateLimitKey(request({ "x-forwarded-for": ip }), "demo")).toBeNull();
    }
    expect(clientRateLimitKey(request({}), "demo")).toBeNull();
  });

  it("never returns null in production: loopback counts, and unknown clients share one bucket", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(clientRateLimitKey(request({ "x-forwarded-for": "::1" }), "demo")).toMatch(/^demo:/);
    const unknown = clientRateLimitKey(request({}), "demo");
    expect(unknown).toMatch(/^demo:/);
    expect(clientRateLimitKey(request({}), "demo")).toBe(unknown);
  });
});
