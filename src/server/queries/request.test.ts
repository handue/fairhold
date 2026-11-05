import { describe, expect, it } from "vitest";

import { parseCategoryParam, parseLotNumber, parsePaddleParam } from "./request";

describe("guest request parsing", () => {
  it("accepts paddle numbers and ignores anything else", () => {
    expect(parsePaddleParam("142")).toBe(142);
    expect(parsePaddleParam(["88", "142"])).toBe(88);
    expect(parsePaddleParam(undefined)).toBeNull();
    expect(parsePaddleParam("0")).toBeNull();
    expect(parsePaddleParam("142abc")).toBeNull();
    expect(parsePaddleParam("-1")).toBeNull();
  });

  it("accepts the five categories only", () => {
    expect(parseCategoryParam("dining")).toBe("dining");
    expect(parseCategoryParam("Dining")).toBeNull();
    expect(parseCategoryParam("all")).toBeNull();
  });

  it("reads zero-padded lot numbers", () => {
    expect(parseLotNumber("07")).toBe(7);
    expect(parseLotNumber("7")).toBe(7);
    expect(parseLotNumber("x")).toBeNull();
  });
});
