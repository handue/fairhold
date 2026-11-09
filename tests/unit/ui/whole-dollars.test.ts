import { describe, expect, it } from "vitest";

import { parseWholeDollars } from "@/ui/lot/whole-dollars";

describe("parseWholeDollars", () => {
  it("reads whole dollars as a guest types them, as cents", () => {
    expect(parseWholeDollars("380")).toBe(38_000);
    expect(parseWholeDollars("$380")).toBe(38_000);
    expect(parseWholeDollars(" 1,000 ")).toBe(100_000);
    expect(parseWholeDollars("9999999")).toBe(999_999_900);
  });

  it("refuses anything else", () => {
    for (const text of ["", " ", "0", "$", "abc", "12.50", "-5", "1e3", "10000000", "٣٨٠"]) {
      expect(parseWholeDollars(text)).toBeNull();
    }
  });
});
