import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * design/29: every one of the 24 lots shows its drawing on 08's tiles and on 05's photo. Run with
 * the seeded fixture event. LOT_DRAWINGS_DIR=<dir> also saves 08 with every lot shown, for
 * comparison with the board.
 */
test.use({ channel: "chrome" });

const CATALOG = "/e/riverside-shelter-gala";
const LOT_NUMBERS = Array.from({ length: 24 }, (_, index) => String(index + 1).padStart(2, "0"));

test("08 draws every lot's cover once all 24 are shown", async ({ page }, testInfo) => {
  await page.goto(CATALOG, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Show 16 more lots" }).click();

  const tiles = page.getByRole("article");
  await expect(tiles).toHaveCount(24);
  for (const tile of await tiles.all()) {
    await expect(tile.locator('svg[viewBox="0 0 120 90"]')).toHaveCount(1);
  }
  const shown = await tiles.evaluateAll((articles) =>
    articles.map((article) => article.textContent?.match(/Lot (\d\d)/i)?.[1]).sort(),
  );
  expect(shown).toEqual(LOT_NUMBERS);

  if (process.env.LOT_DRAWINGS_DIR) {
    mkdirSync(process.env.LOT_DRAWINGS_DIR, { recursive: true });
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    const file = path.join(process.env.LOT_DRAWINGS_DIR, "08-all-lots.png");
    await page.screenshot({ path: file, fullPage: true });
    await testInfo.attach("08-all-lots.png", { path: file, contentType: "image/png" });
  }
});

for (const lot of LOT_NUMBERS) {
  test(`05 draws Lot ${lot}'s cover as its photo`, async ({ page }) => {
    await page.goto(`${CATALOG}/lots/${lot}`);
    await expect(page.getByText(/^PHOTO 1 \/ \d$/)).toBeVisible();
    await expect(page.locator('svg[width="300"]')).toHaveCount(1);
  });
}
