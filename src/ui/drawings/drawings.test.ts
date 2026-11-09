import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RIVERSIDE_LOTS } from "@/server/demo/template";

import { DRAWINGS, isDrawingKey, type Drawing, type DrawingKey } from "./drawings";
import { LotIllustration, type DrawingVariant } from "./LotIllustration";
import { RIVERSIDE_LOT_DRAWINGS } from "./riverside";

const LOT_NUMBERS = Array.from({ length: 24 }, (_, index) => index + 1);
const VARIANTS: readonly DrawingVariant[] = ["tile", "hero", "thumb"];
const BOARD = fileURLToPath(new URL("../../../design/29-lot-drawings.html", import.meta.url));

function coverOf(lotNumber: number): DrawingKey {
  const cover = RIVERSIDE_LOT_DRAWINGS[lotNumber]?.[0];
  if (!cover) throw new Error(`Lot ${lotNumber} has no cover drawing`);
  return cover;
}

const render = (drawing: DrawingKey, variant: DrawingVariant) =>
  renderToStaticMarkup(createElement(LotIllustration, { drawing, variant }));

/** The markup inside the outer <svg>. */
const innerOf = (svg: string) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");

/**
 * SVG markup as a list of tags with sorted attributes, so the board's hand-written HTML and React's
 * output compare equal when they draw the same thing. The board's ink fill is the code's fill-ink.
 */
function canonical(markup: string): string[] {
  const tags: string[] = [];
  for (const [, closing, name, attributes = "", selfClosing] of markup.matchAll(
    /<(\/?)([a-zA-Z]+)((?:\s+[a-zA-Z:-]+="[^"]*")*)\s*(\/?)>/g,
  )) {
    if (closing) {
      tags.push(`</${name}>`);
      continue;
    }
    const sorted = [...attributes.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)]
      .map(([, key, value]) => (key === "fill" && value === "#0B0B0C" ? `class="fill-ink"` : `${key}="${value}"`))
      .sort();
    tags.push(`<${name} ${sorted.join(" ")}>`);
    if (selfClosing) tags.push(`</${name}>`);
  }
  return tags;
}

describe("RIVERSIDE_LOT_DRAWINGS", () => {
  it("covers exactly the template's 24 lots", () => {
    expect(RIVERSIDE_LOTS.map((lot) => lot.number)).toEqual(LOT_NUMBERS);
    expect(Object.keys(RIVERSIDE_LOT_DRAWINGS).map(Number)).toEqual(LOT_NUMBERS);
  });

  it("gives every lot a cover drawn on 08's tile", () => {
    for (const lotNumber of LOT_NUMBERS) {
      const cover = coverOf(lotNumber);
      expect(isDrawingKey(cover), `Lot ${lotNumber}`).toBe(true);
      expect(DRAWINGS[cover], `Lot ${lotNumber}`).toHaveProperty("tile");
    }
  });

  it("gives every lot its own cover; Lot 01's puppy is not Lot 21's dog", () => {
    const covers = LOT_NUMBERS.map(coverOf);
    expect(new Set(covers).size).toBe(24);
    expect(coverOf(1)).toBe("puppy");
    expect(coverOf(21)).toBe("dog");
  });

  it("keeps the eight drawings already on 08, 05, 13 and 14 on their lots", () => {
    expect(Object.fromEntries([3, 5, 7, 9, 12, 14, 18, 21].map((lot) => [lot, RIVERSIDE_LOT_DRAWINGS[lot]]))).toEqual({
      3: ["cabin"],
      5: ["pottery"],
      7: ["cloche", "wine-glass", "chef-hat", "menu-card"],
      9: ["wine"],
      12: ["spa-stones", "steam", "day-passes"],
      14: ["watercolor"],
      18: ["camera"],
      21: ["dog"],
    });
  });

  it("names only drawings that exist", () => {
    for (const keys of Object.values(RIVERSIDE_LOT_DRAWINGS)) {
      for (const key of keys) expect(isDrawingKey(key), key).toBe(true);
    }
    expect(isDrawingKey("toString")).toBe(false);
  });
});

describe("LotIllustration", () => {
  it("renders every lot's cover at every size", () => {
    for (const lotNumber of LOT_NUMBERS) {
      for (const variant of VARIANTS) {
        expect(() => render(coverOf(lotNumber), variant), `Lot ${lotNumber} ${variant}`).not.toThrow();
      }
      expect(render(coverOf(lotNumber), "tile")).toMatch(/^<svg width="140" height="105" viewBox="0 0 120 90"/);
    }
  });

  it("draws every tile at 1.5 on the approved ground line", () => {
    for (const lotNumber of LOT_NUMBERS) {
      const { tile }: Drawing = DRAWINGS[coverOf(lotNumber)];
      expect(tile, `Lot ${lotNumber}`).toMatchObject({ viewBox: "0 0 120 90", strokeWidth: 1.5, fixedStroke: true });
      const markup = render(coverOf(lotNumber), "tile");
      expect(markup, `Lot ${lotNumber}`).toMatch(/<path d="M[\d.]+ 72H[\d.]+"><\/path><path d="M[\d.]+ 78H[\d.]+" opacity="\.35"><\/path>/);
    }
  });

  it("draws in ink only: no lime, no other colors", () => {
    for (const key of Object.keys(DRAWINGS) as DrawingKey[]) {
      const drawing: Drawing = DRAWINGS[key];
      for (const variant of VARIANTS.filter((size) => drawing[size] || drawing.tile)) {
        const markup = render(key, variant);
        expect(markup, `${key} ${variant}`).toMatch(/^<svg [^>]*class="[^"]*stroke-ink/);
        expect(markup, `${key} ${variant}`).not.toMatch(/lime|#[0-9a-f]{3,6}\b|(?:stroke|fill)="(?!none")/i);
      }
    }
  });
});

describe.skipIf(!existsSync(BOARD))("design/29, the approved lot drawings", () => {
  const html = existsSync(BOARD) ? readFileSync(BOARD, "utf8") : "";
  const tiles = [
    ...html.matchAll(/<svg class="ill"([^>]*)>([\s\S]*?)<\/svg><\/div>\s*<div class="info">\s*<span class="eyebrow mono">Lot (\d\d)/g),
  ].map(([, attributes = "", inner = "", lot = ""]) => ({ attributes, inner, lotNumber: Number(lot) }));

  it("draws the 24 lots", () => {
    expect(tiles.map((tile) => tile.lotNumber)).toEqual(LOT_NUMBERS);
  });

  it("is ported path for path, on 08's tile grid and line", () => {
    for (const { attributes, inner, lotNumber } of tiles) {
      expect(attributes, `Lot ${lotNumber}`).toContain(
        'viewBox="0 0 120 90" fill="none" stroke="#0B0B0C" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"',
      );
      const drawn = canonical(inner);
      // More than the two ground lines (four tags).
      expect(drawn.length, `Lot ${lotNumber}`).toBeGreaterThan(4);
      expect(canonical(innerOf(render(coverOf(lotNumber), "tile"))), `Lot ${lotNumber}`).toEqual(drawn);
    }
  });
});
