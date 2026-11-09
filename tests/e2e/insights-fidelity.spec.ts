import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Captures Insights (design/28) on the fixture for the fidelity board: the whole page, 1440 wide at
 * a native 2x, as control-room-fidelity.spec.ts captures 12. Compare it with design/28-insights.png,
 * whose page starts at x=160, y=402 in PNG pixels. The board draws the report once charged; on the
 * closed fixture, before the charge, Hold utilization says "will be charged". Only runs when asked:
 *
 *   npm run db:seed -- --moment=closed --date=2026-11-07
 *   INSIGHTS_FIDELITY_DIR=docs/status PLAYWRIGHT_BASE_URL=http://localhost:3456 \
 *     npx playwright test tests/e2e/insights-fidelity.spec.ts
 */
test.use({
  channel: "chrome",
  launchOptions: {
    args: ["--force-device-scale-factor=2", "--window-size=1440,987", "--hide-scrollbars", "--disable-gpu"],
  },
});

const directory = process.env.INSIGHTS_FIDELITY_DIR;

test("captures ui-28-insights.png", async ({ browser, baseURL }) => {
  test.skip(!directory, "Set INSIGHTS_FIDELITY_DIR and seed the closed fixture");
  const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL });
  const page = await context.newPage();
  await page.goto("/e/riverside-shelter-gala/organizer/insights");
  await expect(page.getByRole("region", { name: "Top lots" }).locator(".ag-row").first()).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(directory ?? "", { recursive: true });
  await page.screenshot({ path: path.join(directory ?? "", "ui-28-insights.png"), fullPage: true });
  await context.close();
});
