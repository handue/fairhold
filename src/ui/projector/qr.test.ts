import { describe, expect, it } from "vitest";

import { qrPath } from "./qr";

describe("qrPath", () => {
  it("draws 14's code: a version 2 symbol with its 4-module quiet zone, finder pattern first", () => {
    const qr = qrPath("https://riverside-gala.example");
    expect(qr.size).toBe(33);
    expect(qr.d.startsWith("M4 4h7v1h-7z")).toBe(true);
  });

  it("grows with a longer link and stays inside its viewBox", () => {
    const qr = qrPath("https://fairhold.onrender.com/e/gala-7k2m9q4x1ce8vbnt");
    expect(qr.size).toBeGreaterThan(33);
    const coordinates = [...qr.d.matchAll(/M(\d+) (\d+)h(\d+)/g)].map(([, x, y, length]) => [Number(x) + Number(length), Number(y)]);
    expect(Math.max(...coordinates.map(([right]) => right ?? 0))).toBeLessThanOrEqual(qr.size - 4);
    expect(Math.max(...coordinates.map(([, row]) => row ?? 0))).toBeLessThan(qr.size - 4);
  });
});
