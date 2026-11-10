import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * 10 My paddle and 14 the projector at the seeded 9:15:40 PM, and 11's place while bidding is open.
 * Run against a server with the paddle moment and its frozen clock:
 *
 *   npm run db:seed -- --moment=paddle --date=2026-11-07      # prints FREEZE_CLOCK_AT
 *   FREEZE_CLOCK_AT=2026-11-08T05:15:40.000Z npx next dev -p 3464
 *   PLAYWRIGHT_BASE_URL=http://localhost:3464 FREEZE_CLOCK_AT=2026-11-08T05:15:40.000Z \
 *     npx playwright test tests/e2e/paddle-receipt-projector.spec.ts
 *
 * FIDELITY_DIR=docs/status also writes the captures at 2x for comparison with mockups/10 and 14.
 */
const FROZEN = new Date(process.env.FREEZE_CLOCK_AT ?? "2026-11-08T05:15:40Z");
const GALA = "/e/riverside-shelter-gala";

test.use({ deviceScaleFactor: 2 });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FROZEN);
});

async function capture(page: import("@playwright/test").Page, file: string, testInfo: import("@playwright/test").TestInfo) {
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  const directory = process.env.FIDELITY_DIR ?? testInfo.outputDir;
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, file) });
}

test("10 shows the hold, Jamie's lots and Glim's activity at 9:15:40", async ({ page }, testInfo) => {
  await page.goto(`${GALA}/paddle?paddle=142`, { waitUntil: "networkidle" });
  const money = page.getByRole("region", { name: "Bidding power" });
  await expect(money).toContainText("$500 held with PayPal");
  await expect(money).toContainText("$470in winning bids");
  await expect(money).toContainText("left · Glim’s room on Spa Day");
  await expect(money.getByRole("link", { name: "Raise bidding power" })).toHaveAttribute("href", /\/power\?paddle=142&next=/);

  const lots = page.getByRole("region", { name: "My lots" });
  await expect(lots.getByRole("article")).toHaveCount(3);
  await expect(lots).toContainText("Glim’s limit $380 · reached");
  await expect(lots).toContainText("Glim’s limit $120 · $30 of room left");
  await expect(lots).toContainText("Not in Glim’s plan · outbid");
  await expect(lots).toContainText("Sold for $95");

  const glim = page.getByRole("region", { name: "Glim’s activity" });
  await expect(glim).toContainText("On duty since 9:11 PM");
  await expect(glim.getByRole("button", { name: "Pause" })).toBeVisible();
  await expect(glim.getByRole("listitem")).toHaveCount(4);
  await expect(glim.getByRole("listitem").first()).toContainText("9:14 PM · CHEF’S TABLE");
  await capture(page, "ui-10-my-paddle.png", testInfo);
});

test("11 waits for the close: while bidding is open it sends the guest to 10", async ({ page }) => {
  await page.goto(`${GALA}/receipt?paddle=142`, { waitUntil: "networkidle" });
  await expect(page).toHaveURL(/\/paddle\?paddle=142$/);
});

test("14 shows the room's board with paddle numbers and no names", async ({ page }, testInfo) => {
  await page.goto(`${GALA}/projector`, { waitUntil: "networkidle" });
  await expect(page.getByText("$7,720")).toBeVisible();
  await expect(page.getByText("24 lots · 86 bidders")).toBeVisible();
  await expect(page.getByText("16 more lots at 9:30 PM")).toBeVisible();
  await expect(page.getByRole("article", { name: "Closing now: Chef’s Table Dinner for Four" })).toContainText("Paddle 142");
  await expect(page.getByText("Bid by Glim")).toHaveCount(3);
  await expect(page.getByText("I’m bidding for 29 guests")).toBeVisible();
  await expect(page.getByText("Jamie")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /QR code for/ })).toBeVisible();
  await capture(page, "ui-14-projector.png", testInfo);
});
