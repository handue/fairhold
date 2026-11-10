import { expect, type Page } from "@playwright/test";

/**
 * The widths every page is checked at below the approved 1440: a small phone, the phone the
 * layouts are drawn for, a large phone, a tablet in portrait and landscape, and common laptops.
 * At 1440 the fidelity specs hold each page to its approved board.
 */
export const WIDTHS = [320, 375, 430, 768, 1024, 1280, 1366] as const;
export type Width = (typeof WIDTHS)[number];

export const HEIGHT_FOR: Record<Width, number> = { 320: 640, 375: 812, 430: 932, 768: 1024, 1024: 768, 1280: 800, 1366: 768 };

export async function atWidth(page: Page, width: Width): Promise<void> {
  await page.setViewportSize({ width, height: HEIGHT_FOR[width] });
}

/**
 * Nothing on the page reaches past the viewport sideways: the document doesn't scroll
 * horizontally, and no visible element (outside a container that scrolls on purpose, such as a
 * grid or a chip row) sticks out of the right or left edge.
 */
export async function expectNoHorizontalOverflow(page: Page, label = ""): Promise<void> {
  const report = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    const scrolls = (element: Element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll|hidden|clip)/.test(style.overflowX);
    };
    const insideScroller = (element: Element) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (scrolls(parent)) return true;
      }
      return false;
    };
    const offenders: string[] = [];
    for (const element of document.body.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || style.position === "fixed" && rect.right <= 0) continue;
      if (element.closest("[aria-hidden=true], .sr-only, nextjs-portal")) continue;
      if ((rect.right > width + 1 || rect.left < -1) && !insideScroller(element)) {
        const name = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${String(element.className).split(" ").slice(0, 3).join(".")}`;
        offenders.push(`${name} [${Math.round(rect.left)}..${Math.round(rect.right)}] "${(element.textContent ?? "").trim().slice(0, 40)}"`);
        if (offenders.length >= 8) break;
      }
    }
    return { scrollWidth: document.documentElement.scrollWidth, width, offenders };
  });
  expect(report.scrollWidth, `${label} scrolls sideways: ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(report.width);
  expect(report.offenders, `${label} elements past the edge`).toEqual([]);
}

/**
 * Text that is cut off without an ellipsis: an element whose own text is wider than its box and
 * that neither scrolls nor ends in "…" on purpose.
 */
export async function expectNoClippedText(page: Page, label = ""): Promise<void> {
  const clipped = await page.evaluate(() => {
    const found: string[] = [];
    for (const element of document.body.querySelectorAll<HTMLElement>("*")) {
      if (!element.childNodes.length || ![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim())) continue;
      const style = getComputedStyle(element);
      if (style.textOverflow === "ellipsis" || /(auto|scroll)/.test(style.overflowX)) continue;
      if (element.closest("[aria-hidden=true], .sr-only, nextjs-portal")) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0) continue;
      if (element.scrollWidth > element.clientWidth + 1 && /(hidden|clip)/.test(style.overflowX)) {
        found.push(`${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 40)}"`);
        if (found.length >= 8) break;
      }
    }
    return found;
  });
  expect(clipped, `${label} text cut off`).toEqual([]);
}

/** Buttons and links a thumb has to hit are at least 40 by 40 on a phone (44 is the goal). */
export async function expectTappableTargets(page: Page, label = "", minimum = 40): Promise<void> {
  const small = await page.evaluate((min) => {
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>("main a[href], main button, header a[href], header button, [role=dialog] button")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (element.closest("[aria-hidden=true], .sr-only")) continue;
      if (rect.width < min || rect.height < min) {
        // Inline text links inside a sentence are exempt; they wrap with the text.
        if (element.tagName === "A" && getComputedStyle(element).display === "inline") continue;
        found.push(`${element.tagName.toLowerCase()} "${(element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
    return found;
  }, minimum);
  expect(small, `${label} small tap targets`).toEqual([]);
}
