import { mkdirSync } from "node:fs";

import { expect as baseExpect, test, type Browser, type Page } from "@playwright/test";

/**
 * The whole path as the app ships, in real browsers on the real tick and the real clock: a demo from
 * the home page, the nav's pill to 09, a hold through the window, a bid a second browser sees, the
 * golden sentence with its "On my own" block, Start bidding, the director's rivals, and the rival's
 * $400 making Glim move the $380 left to Wine Tasting with a $220 bid, with no tap (design/21 V2).
 * Then the demo menu's Close bidding now (design/18), 12 charging, 11's receipt, 10 after the close,
 * 14's projector and Insights (design/28).
 *
 * The rivals need the tick, so this runs only when asked, against a server with the same setting:
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=true npx next dev -p 3456
 *   ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/golden-path.spec.ts
 *
 * GOLDEN_PATH_SHOTS=<folder> also saves a screenshot of each step there, for a rehearsal.
 */
test.use({ channel: "chrome" });
// The rivals alone take up to about 95 seconds, and a cold dev server compiles every page first.
test.setTimeout(300_000);

const expect = baseExpect.configure({ timeout: 30_000 });

const GOLDEN_SENTENCE = "$500. I really want the chef’s dinner. Spa only under $120.";
const SHOTS = process.env.GOLDEN_PATH_SHOTS;

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `192.${octet()}.${octet()}.${octet()}` });
});

// The page's own nav; Glim's panel has a banner of its own after it.
const nav = (page: Page) => page.getByRole("banner").first();
const bidCard = (page: Page) => page.getByRole("region", { name: "Place a bid" });
const rail = (page: Page) => page.getByRole("complementary").filter({ hasText: /Bidding (open|closed)/ });

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function secondGuest(browser: Browser, catalog: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${catalog}/join`);
  await page.getByLabel("First name").fill("Kai");
  await page.getByRole("button", { name: "Get my paddle" }).click();
  await page.waitForURL(catalog);
  return page;
}

/** The demo menu behind the creator's paddle pill (design/18). */
async function demoMenu(page: Page) {
  await nav(page).getByRole("button", { name: /Jamie/ }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("from a new demo, with Glim moving money on its own, to the receipt", async ({ page, browser }) => {
  test.skip(process.env.ENGINE_ENABLED !== "true", "Needs a server with ENGINE_ENABLED=true, and the same setting here");

  // design/16: one button, and the creator is Jamie, paddle 142, with nothing held.
  await page.goto("/");
  await shot(page, "01-home");
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  const catalog = new URL(page.url()).pathname;
  await expect(nav(page)).toContainText("Not set");
  await expect(nav(page)).toContainText("Sandbox demo");
  await shot(page, "02-lots-not-set");

  // Kai joins from a browser of his own (design/16b).
  const kai = await secondGuest(browser, catalog);

  // 14 while bidding is live, on a demo gala (C6).
  await kai.goto(`${catalog}/projector`);
  await expect(kai.getByText("Your bids are backed by bidding power held with PayPal.")).toBeVisible();
  await shot(kai, "02b-projector-live");

  // The nav's pill leads to 09; the hold goes through the window, and the guest comes back.
  await nav(page).getByRole("link", { name: /Bidding power/ }).click();
  await page.waitForURL(new RegExp(`${catalog}/power`));
  const hold = page.getByRole("main").getByRole("button", { name: "Hold $500 with PayPal" });
  await expect(hold).toBeEnabled();
  await expect
    .poll(() => hold.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
  await shot(page, "03-power");
  const popupOpened = page.waitForEvent("popup");
  await hold.click();
  const popup = await popupOpened;
  if (!popup.isClosed()) await popup.waitForEvent("close");
  await expect(nav(page)).toContainText("$500 / $500");
  await page.waitForURL(catalog);

  // A bid on Chef's Table reaches the second browser with no reload.
  await kai.goto(`${catalog}/lots/07`);
  await expect(bidCard(kai)).toContainText("$320");
  await page.goto(`${catalog}/lots/07`);
  await bidCard(page).getByRole("button", { name: /Place bid/ }).click();
  await expect(nav(page)).toContainText("$180 / $500");
  await expect(bidCard(page)).toContainText("You’re winning");
  await expect(bidCard(kai)).toContainText("$340");
  await shot(page, "04-lot-winning");

  // A bid over what is left isn't offered: the card says why and offers a raise (design/19 state 3).
  await page.goto(`${catalog}/lots/03`);
  await expect(bidCard(page)).toContainText("You have $180 left of $500.");
  await expect(bidCard(page).getByRole("link", { name: "Raise bidding power" })).toBeVisible();

  // Jamie hearts Wine Tasting, which makes it the plan's backup (design/21 V1).
  await page.goto(`${catalog}/lots/09`);
  const heart = page.getByRole("button", { name: "Save to my lots" });
  await expect
    .poll(() => heart.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
  const saved = page.waitForResponse((response) => response.url().endsWith("/lots/9/favorite") && response.request().method() === "POST");
  await heart.click();
  expect((await saved).ok()).toBe(true);
  await expect(heart).toHaveAttribute("aria-pressed", "true");

  // The golden sentence, the card with Glim's own rules (design/21 V1), and Start bidding.
  await page.goto(`${catalog}/lots/07`);
  await page.getByRole("button", { name: "Chat with Glim" }).click();
  const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
  await expect(panel.getByText("Not bidding yet · $500 held with PayPal")).toBeVisible();
  await panel.getByLabel("Message Glim").fill(GOLDEN_SENTENCE);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText("My plan for you")).toBeVisible();
  await expect(panel.getByText("$380")).toBeVisible();
  await expect(panel.getByText("On my own")).toBeVisible();
  await expect(panel.getByText("Wine Tasting", { exact: false }).first()).toBeVisible();
  await expect(panel.getByText("Never past $500 in all, and Spa Day up to $120.")).toBeVisible();
  await shot(page, "05-plan-card");
  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByText("I bid $90 for you. I’ll go up to $120.")).toBeVisible();
  await expect(panel.getByText("On duty · $500 held with PayPal")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pause Glim" })).toBeVisible();

  // The director's rivals, on the real tick, into the open panel.
  await expect(panel.getByText("Someone bid $360. I raised to $380, your limit for this lot.")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText("Someone bid $400, over your $380 limit.")).toBeVisible({ timeout: 90_000 });

  // With no tap, Glim moves the $380 left to Wine Tasting and bids $220 (design/21 V2), and offers Skip.
  await expect(panel.getByText("I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByRole("button", { name: "Skip Wine Tasting" })).toBeVisible();
  await expect(nav(page)).toContainText("$190 / $500");
  await shot(page, "06-autopilot-card");

  // 10 shows the move: Wine Tasting winning at $220 in the rows and in Glim's feed.
  await nav(page).getByRole("link", { name: "My paddle" }).click();
  await page.waitForURL(new RegExp(`${catalog}/paddle`));
  await expect(page.getByRole("region", { name: "My lots" })).toContainText("Wine Tasting");
  const feed = page.getByRole("region", { name: "Glim’s activity" });
  await expect(feed).toContainText("WINE TASTING");
  await expect(feed).toContainText("I moved the $380 left to Wine Tasting.");
  await expect(feed).toContainText("Winning · $220");
  await shot(page, "07-my-paddle");

  // Close bidding now, from the demo menu (design/18). 10 then leads to 11, closed and not yet charged (B3).
  await (await demoMenu(page)).getByRole("menuitem", { name: "Close bidding now" }).click();
  await page.waitForURL(new RegExp(`${catalog}/receipt`));
  await expect(nav(page)).toContainText("Closed at");
  await expect(page.getByRole("complementary")).toContainText("Receipt pending");
  await expect(page.getByRole("complementary")).toContainText(/\$310\s*to pay with PayPal/);
  await shot(page, "08-receipt-pending");

  // The control room, from the same menu: the checks pass, and the winners are charged.
  await (await demoMenu(page)).getByRole("menuitemradio", { name: "Organizer view" }).click();
  await page.waitForURL(new RegExp(`${catalog}/organizer$`));
  await expect(rail(page).getByRole("heading")).toHaveText("Ready to charge");
  await expect(rail(page)).toContainText("All passed");
  await shot(page, "09-control-room-ready");
  await rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ }).click();
  await expect(rail(page).getByRole("heading")).toHaveText(/\d+ winners? charged/);
  await expect(rail(page)).toContainText("Every hold is settled");
  await page.getByLabel("Search bidders or lots").fill("142");
  const row = page.getByRole("grid").getByRole("row").filter({ hasText: "142" }).first();
  await expect(row).toContainText("Charged");
  await expect(row).toContainText("$310");
  await expect(row).toContainText("$190");
  await shot(page, "10-control-room-charged");

  // 11: Jamie's receipt, from the rail's lime button: Wine Tasting and Spa Day won by Glim.
  await rail(page).getByRole("link", { name: "See your receipt" }).click();
  await page.waitForURL(new RegExp(`${catalog}/receipt`));
  const receipt = page.getByRole("main");
  await expect(page.getByRole("complementary")).toContainText("Sandbox demo · not a tax document");
  await expect(page.getByRole("complementary")).toContainText(/\$310\s*paid with PayPal/);
  await expect(receipt).toContainText("Wine Tasting");
  await expect(receipt).toContainText("Spa Day");
  await shot(page, "11-receipt");

  // 10 after the close leads to 11 (B3).
  await page.goto(`${catalog}/paddle`);
  await page.waitForURL(new RegExp(`${catalog}/receipt`));

  // 14, on the venue's screen: the sold lots and the Sandbox demo marker.
  await page.goto(`${catalog}/projector`);
  await expect(page.getByText("Sandbox demo")).toBeVisible();
  await expect(page.getByRole("region", { name: "Raised tonight" })).toBeVisible();
  await expect(page.getByText("I bid for 1 guest")).toBeVisible();
  await shot(page, "12-projector");

  // Insights (design/28), from the organizer's nav.
  await page.goto(`${catalog}/organizer`);
  await page.getByRole("banner").getByRole("link", { name: "Insights" }).click();
  await page.waitForURL(new RegExp(`${catalog}/organizer/insights`));
  await expect(page.getByRole("region", { name: "Raised", exact: true })).toContainText("for Riverside Animal Shelter");
  await shot(page, "13-insights");

  await kai.context().close();
});
