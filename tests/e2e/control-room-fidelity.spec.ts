import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Captures the approved 12 for the fidelity board: 1440x900 at a native 2x, the way the approved PNGs
 * were rendered (see fidelity.spec.ts). Compare it with mockups/12-web-control-room.png, whose page
 * area starts at x=160, y=224 in PNG pixels. It needs the closed fixture, so it only runs when asked:
 *
 *   npm run db:seed -- --moment=closed --date=2026-11-07
 *   CONTROL_ROOM_FIDELITY_DIR=docs/status PLAYWRIGHT_BASE_URL=http://localhost:3456 \
 *     npx playwright test tests/e2e/control-room-fidelity.spec.ts
 */
test.use({
  channel: "chrome",
  launchOptions: {
    // Headless Chrome keeps 87px of the window for its own frame.
    args: ["--force-device-scale-factor=2", "--window-size=1440,987", "--hide-scrollbars", "--disable-gpu"],
  },
});

const directory = process.env.CONTROL_ROOM_FIDELITY_DIR;

test("captures ui-12-control-room.png", async ({ browser, baseURL }) => {
  test.skip(!directory, "Set CONTROL_ROOM_FIDELITY_DIR and seed the closed fixture");
  const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL });
  const page = await context.newPage();
  await page.goto("/e/riverside-shelter-gala/organizer");
  await expect(page.locator(".ag-row").first()).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(directory ?? "", { recursive: true });
  await page.screenshot({ path: path.join(directory ?? "", "ui-12-control-room.png") });
  await context.close();
});
