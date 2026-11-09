import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import pg from "pg";

/**
 * Captures the approved 09 for the fidelity board: 1440x900 at a native 2x, the way the approved PNGs
 * were rendered (see fidelity.spec.ts). Compare it with mockups/09-web-bidding-power.png, whose page
 * area starts at x=160, y=224 in PNG pixels. 09 draws Jamie before her first hold and bid, which the
 * fixture has already passed, so this test takes both away. It only runs when asked; reseed afterwards:
 *
 *   npm run db:seed
 *   FREEZE_CLOCK_AT=<the seed's> npx next dev -p 3456
 *   POWER_FIDELITY_DIR=docs/status DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 \
 *     npx playwright test tests/e2e/power-fidelity.spec.ts
 */
test.use({
  channel: "chrome",
  launchOptions: {
    // Headless Chrome keeps 87px of the window for its own frame.
    args: ["--force-device-scale-factor=2", "--window-size=1440,987", "--hide-scrollbars", "--disable-gpu"],
  },
});

const directory = process.env.POWER_FIDELITY_DIR;
const SLUG = "riverside-shelter-gala";

/** Jamie as 09 draws her: no hold, and her lead on Chef's Table back with paddle 88. */
async function beforeJamiesFirstHold(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev" });
  await client.connect();
  try {
    await client.query(
      `with paddle as (
         select p.id, p.event_id from paddles p join events e on e.id = p.event_id where e.slug = $1 and p.number = 142
       ), rival as (
         select p.id from paddles p join paddle on p.event_id = paddle.event_id where p.number = 88
       ), holds_gone as (
         delete from holds where paddle_id = (select id from paddle)
       ), bids_moved as (
         update bids set paddle_id = (select id from rival) where paddle_id = (select id from paddle)
       )
       update lots set high_paddle_id = (select id from rival) where high_paddle_id = (select id from paddle)`,
      [SLUG],
    );
  } finally {
    await client.end();
  }
}

test("captures ui-09-power.png", async ({ browser, baseURL }) => {
  test.skip(!directory, "Set POWER_FIDELITY_DIR, on a seeded fixture you can reseed afterwards");
  await beforeJamiesFirstHold();
  const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL });
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(process.env.FREEZE_CLOCK_AT ?? "2026-11-08T04:58:00Z"));
  await page.goto(`/e/${SLUG}/power`);
  await expect(page.getByRole("heading", { name: "Set your bidding power" })).toBeVisible();
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync(directory ?? "", { recursive: true });
  await page.screenshot({ path: path.join(directory ?? "", "ui-09-power.png") });
  await context.close();
});
