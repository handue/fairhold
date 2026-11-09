import { describe, expect, it } from "vitest";

import {
  hashSessionToken,
  newSessionToken,
  readCookieHeader,
  sessionCookieHeader,
  sessionCookieName,
} from "@/server/sessions/cookie";

const SECRET = "test-only-".repeat(4);

describe("the session cookie", () => {
  it("is httpOnly and SameSite=Lax on every path of the site", () => {
    const header = sessionCookieHeader("gala-abc", "TOKEN", 3_600, false);
    expect(header.split("; ")).toEqual(["fh_s_gala-abc=TOKEN", "Path=/", "Max-Age=3600", "HttpOnly", "SameSite=Lax"]);
  });

  it("is Secure when asked", () => {
    expect(sessionCookieHeader("gala-abc", "TOKEN", 3_600, true).split("; ")).toContain("Secure");
  });

  it("has one name per event, safe whatever the slug holds", () => {
    expect(sessionCookieName("riverside-shelter-gala")).toBe("fh_s_riverside-shelter-gala");
    expect(sessionCookieName("a;b=c d")).toBe("fh_s_a_b_c_d");
  });

  it("is read back from a Cookie header", () => {
    const header = "other=1; fh_s_gala-abc=TOKEN==; fh_s_gala-xyz=OTHER";
    expect(readCookieHeader(header, "fh_s_gala-abc")).toBe("TOKEN==");
    expect(readCookieHeader(header, "fh_s_gala")).toBeNull();
    expect(readCookieHeader(null, "fh_s_gala-abc")).toBeNull();
    expect(readCookieHeader("nonsense", "nonsense")).toBeNull();
  });
});

describe("the session token", () => {
  it("is long, random and URL-safe", () => {
    const token = newSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(token);
  });

  it("is stored only as a keyed hash", () => {
    const hash = hashSessionToken("TOKEN", SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("TOKEN");
    expect(hashSessionToken("TOKEN", SECRET)).toBe(hash);
    expect(hashSessionToken("TOKEN", "another-secret-".repeat(3))).not.toBe(hash);
  });
});
