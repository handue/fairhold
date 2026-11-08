import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

/**
 * Captures the guest screens for the fidelity board: 1440x900 at a native 2x, the way the approved
 * PNGs were rendered (`chrome --headless --force-device-scale-factor=2`). Playwright's emulated
 * device scale factor rasterizes text half a pixel differently, so these captures use a real 2x
 * window instead.
 *
 * FIDELITY_DIR=docs/status writes the PNGs there; otherwise they land in the test output.
 * Compare a capture with the approved PNG's page area, which starts at x=160, y=224 in PNG pixels.
 */
const VIEWPORT = { width: 1440, height: 900 };
// Headless Chrome keeps 87px of the window for its own frame.
const WINDOW_FRAME_HEIGHT = 87;

/**
 * Stops the browser's clock, so the countdowns stay at what the server rendered. Run the server with
 * the FREEZE_CLOCK_AT that npm run db:seed prints; the browser only measures time since hydration.
 */
const FROZEN_BROWSER_CLOCK = new Date(process.env.FREEZE_CLOCK_AT ?? "2026-11-08T04:58:00Z");

const SCREENS = [
  { file: "ui-08-lots.png", path: "/e/riverside-shelter-gala" },
  { file: "ui-05-lot-detail.png", path: "/e/riverside-shelter-gala/lots/07" },
];

test.use({
  channel: "chrome",
  launchOptions: {
    args: [
      "--force-device-scale-factor=2",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height + WINDOW_FRAME_HEIGHT}`,
      "--hide-scrollbars",
      "--disable-gpu",
    ],
  },
});

for (const screen of SCREENS) {
  test(`captures ${screen.file}`, async ({ browser, baseURL }, testInfo) => {
    // Without a viewport the page keeps the window's size and scale; the project's device preset
    // would otherwise bring its own scale factor.
    const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL });
    const page = await context.newPage();
    await page.clock.setFixedTime(FROZEN_BROWSER_CLOCK);
    await page.goto(screen.path, { waitUntil: "networkidle" });
    // The dev server's floating indicator is not part of the page.
    await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
    await page.evaluate(() => document.fonts.ready);

    const metrics = await page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      scale: window.devicePixelRatio,
    }));
    expect(metrics).toEqual({ ...VIEWPORT, scale: 2 });

    const directory = process.env.FIDELITY_DIR ?? testInfo.outputDir;
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, screen.file);
    await page.screenshot({ path: file });
    await testInfo.attach(screen.file, { path: file, contentType: "image/png" });
    await context.close();
  });
}
