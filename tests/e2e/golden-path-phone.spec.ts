import { mkdirSync } from "node:fs";

import { devices, expect as baseExpect, test, type Browser, type Locator, type Page } from "@playwright/test";

import { expectNoHorizontalOverflow } from "./support/responsive";

/**
 * golden-path.spec.ts on a phone: the same shipped path, at 375x812 with a phone's user agent, touch
 * and a 3x screen. A demo from the home page, the hold through the window, a bid a second phone sees,
 * the heart, the golden sentence in Glim's full-screen sheet, Start bidding, the director's rivals,
 * Glim's own move with no tap, the demo menu's Close bidding now, the charge from the control room,
 * and the receipt. Every page it passes is checked for sideways overflow, with the sheet open too.
 *
 * The rivals need the tick, so this runs only when asked, against a server with the same setting:
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=true npx next dev -p 3456
 *   ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/golden-path-phone.spec.ts
 *
 * GOLDEN_PATH_SHOTS=<folder> also saves a screenshot of the screen at each step there.
 */
const PHONE = {
  userAgent: devices["Pixel 7"].userAgent,
  viewport: { width: 375, height: 812 },
  screen: { width: 375, height: 812 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
test.use({ channel: "chrome", ...PHONE });
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

/** The step's screen, once the page (not its loading fallback) is drawn, and nothing past its edges. */
async function step(page: Page, name: string): Promise<void> {
  // The projector has no main; its figures are labelled sections.
  await expect(page.locator("main, [role=dialog], section[aria-label]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expectNoHorizontalOverflow(page, name);
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  // The dev server's floating indicator is not part of the page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: `${SHOTS}/phone-${name}.png` });
}

/** A press with a thumb, once React is listening. */
async function tap(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
  await locator.tap();
}

async function secondGuest(browser: Browser, catalog: string): Promise<Page> {
  const context = await browser.newContext({ ...PHONE });
  const page = await context.newPage();
  await page.goto(`${catalog}/join`);
  await page.getByLabel("First name").fill("Kai");
  await page.getByRole("button", { name: "Get my paddle" }).tap();
  await page.waitForURL(catalog);
  return page;
}

/** The demo menu behind the creator's paddle pill (design/18), which shows only the number on a phone. */
async function demoMenu(page: Page) {
  await tap(nav(page).getByRole("button", { name: /Jamie/ }));
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("on a phone, from a new demo, with Glim moving money on its own, to the receipt", async ({ page, browser }) => {
  test.skip(process.env.ENGINE_ENABLED !== "true", "Needs a server with ENGINE_ENABLED=true, and the same setting here");

  // design/16: one button, full width on a phone.
  await page.goto("/");
  await step(page, "01-home");
  await tap(page.getByRole("button", { name: "Start a demo gala" }));
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  const catalog = new URL(page.url()).pathname;
  await expect(nav(page)).toContainText("Not set");
  await expect(nav(page)).toContainText("Sandbox demo");
  await step(page, "02-lots-not-set");

  // Kai joins from a phone of his own (design/16b).
  const kai = await secondGuest(browser, catalog);
  await step(kai, "02a-kai-lots");

  // 14 on Kai's phone while bidding is live, on a demo gala (C6).
  await kai.goto(`${catalog}/projector`);
  await expect(kai.getByText("Your bids are backed by bidding power held with PayPal.")).toBeVisible();
  await step(kai, "02b-projector-live");

  // The nav's pill ("Not set" on a phone) leads to 09; the hold goes through the window.
  await tap(nav(page).getByRole("link", { name: /Bidding power/ }));
  await page.waitForURL(new RegExp(`${catalog}/power`));
  const hold = page.getByRole("main").getByRole("button", { name: "Hold $500 with PayPal" });
  await expect(hold).toBeEnabled();
  await step(page, "03-power");
  const popupOpened = page.waitForEvent("popup");
  await tap(hold);
  const popup = await popupOpened;
  if (!popup.isClosed()) await popup.waitForEvent("close");
  await expect(nav(page)).toContainText("$500 / $500");
  await page.waitForURL(catalog);
  await step(page, "03b-lots-held");

  // A bid on Chef's Table reaches the second phone with no reload.
  await kai.goto(`${catalog}/lots/07`);
  await expect(bidCard(kai)).toContainText("$320");
  await page.goto(`${catalog}/lots/07`);
  await step(page, "04a-lot");
  await tap(bidCard(page).getByRole("button", { name: /Place bid/ }));
  await expect(nav(page)).toContainText("$180 / $500");
  await expect(bidCard(page)).toContainText("You’re winning");
  await expect(bidCard(kai)).toContainText("$340");
  await step(page, "04-lot-winning");

  // A bid over what is left isn't offered: the card says why and offers a raise (design/19 state 3).
  await page.goto(`${catalog}/lots/03`);
  await expect(bidCard(page)).toContainText("You have $180 left of $500.");
  await expect(bidCard(page).getByRole("link", { name: "Raise bidding power" })).toBeVisible();
  await step(page, "04b-lot-over-power");

  // Jamie hearts Wine Tasting, which makes it the plan's backup (design/21 V1).
  await page.goto(`${catalog}/lots/09`);
  const heart = page.getByRole("button", { name: "Save to my lots" });
  const saved = page.waitForResponse((response) => response.url().endsWith("/lots/9/favorite") && response.request().method() === "POST");
  await tap(heart);
  expect((await saved).ok()).toBe(true);
  await expect(heart).toHaveAttribute("aria-pressed", "true");

  // The golden sentence in Glim's full-screen sheet, the plan card, and Start bidding.
  await page.goto(`${catalog}/lots/07`);
  await tap(page.getByRole("button", { name: "Chat with Glim" }));
  const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
  await expect(panel.getByText("Not bidding yet · $500 held with PayPal")).toBeVisible();
  const sheet = await panel.boundingBox();
  expect(sheet).toMatchObject({ x: 0, y: 0, width: 375, height: 812 });
  await step(page, "05a-panel-open");
  await panel.getByLabel("Message Glim").fill(GOLDEN_SENTENCE);
  await tap(panel.getByRole("button", { name: "Send" }));
  await expect(panel.getByText("My plan for you")).toBeVisible();
  await expect(panel.getByText("$380")).toBeVisible();
  await expect(panel.getByText("On my own")).toBeVisible();
  await expect(panel.getByText("Wine Tasting", { exact: false }).first()).toBeVisible();
  await expect(panel.getByText("Never past $500 in all, and Spa Day up to $120.")).toBeVisible();
  await step(page, "05-plan-card");
  const start = panel.getByRole("button", { name: "Start bidding" });
  await start.scrollIntoViewIfNeeded();
  expect((await start.boundingBox())?.height ?? 0, "Start bidding's height on a phone").toBeGreaterThanOrEqual(44);
  await tap(start);
  await expect(panel.getByText("I bid $90 for you. I’ll go up to $120.")).toBeVisible();
  await expect(panel.getByText("On duty · $500 held with PayPal")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Pause Glim" })).toBeVisible();

  // The director's rivals, on the real tick, into the open sheet.
  await expect(panel.getByText("Someone bid $360. I raised to $380, your limit for this lot.")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText("Someone bid $400, over your $380 limit.")).toBeVisible({ timeout: 90_000 });

  // With no tap, Glim moves the $380 left to Wine Tasting and bids $220 (design/21 V2), and offers Skip.
  await expect(panel.getByText("I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(panel.getByRole("button", { name: "Skip Wine Tasting" })).toBeVisible();
  await step(page, "06-autopilot-card");
  await tap(panel.getByRole("button", { name: "Close" }).first());
  await expect(panel).toBeHidden();
  await expect(nav(page)).toContainText("$190 / $500");

  // 10 shows the move: Wine Tasting winning at $220 in the rows and in Glim's feed.
  await tap(nav(page).getByRole("link", { name: "My paddle" }));
  await page.waitForURL(new RegExp(`${catalog}/paddle`));
  await expect(page.getByRole("region", { name: "My lots" })).toContainText("Wine Tasting");
  const feed = page.getByRole("region", { name: "Glim’s activity" });
  await expect(feed).toContainText("WINE TASTING");
  await expect(feed).toContainText("I moved the $380 left to Wine Tasting.");
  await expect(feed).toContainText("Winning · $220");
  await step(page, "07-my-paddle");

  // Close bidding now, from the demo menu (design/18). 10 then leads to 11, closed and not yet charged (B3).
  const menu = await demoMenu(page);
  await step(page, "07b-demo-menu");
  await tap(menu.getByRole("menuitem", { name: "Close bidding now" }));
  await page.waitForURL(new RegExp(`${catalog}/receipt`));
  await expect(nav(page)).toContainText("Closed");
  await expect(page.getByRole("complementary")).toContainText("Receipt pending");
  await expect(page.getByRole("complementary")).toContainText(/\$310\s*to pay with PayPal/);
  await step(page, "08-receipt-pending");

  // The control room, from the same menu: the checks pass, and the winners are charged.
  await tap((await demoMenu(page)).getByRole("menuitemradio", { name: "Organizer view" }));
  await page.waitForURL(new RegExp(`${catalog}/organizer$`));
  await expect(rail(page).getByRole("heading")).toHaveText("Ready to charge");
  await expect(rail(page)).toContainText("All passed");
  await step(page, "09-control-room-ready");
  const chargeButton = rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ });
  const chargeBox = await chargeButton.boundingBox();
  expect(chargeBox?.height ?? 0, "Charge winners' height on a phone").toBeGreaterThanOrEqual(44);
  await tap(chargeButton);
  await expect(rail(page).getByRole("heading")).toHaveText(/\d+ winners? charged/);
  await expect(rail(page)).toContainText("Every hold is settled");
  await page.getByLabel("Search bidders or lots").fill("142");
  // On a phone the grid scrolls inside its frame with the Paddle column pinned, so a row is drawn in two
  // parts that share a row id: the pinned paddle cell, and the rest.
  const pinned = page.locator(".ledger-grid .ag-row").filter({ hasText: "142" }).first();
  await expect(pinned).toBeVisible();
  const rowId = await pinned.getAttribute("row-id");
  const row = page.locator(`.ledger-grid .ag-row[row-id="${rowId}"]`);
  await expect.poll(async () => (await row.allInnerTexts()).join(" ")).toContain("Charged");
  const rowText = (await row.allInnerTexts()).join(" ");
  expect(rowText).toContain("$310");
  expect(rowText).toContain("$190");
  await step(page, "10-control-room-charged");

  // 11: Jamie's receipt, from the rail's lime button: Wine Tasting and Spa Day won by Glim.
  await tap(rail(page).getByRole("link", { name: "See your receipt" }));
  await page.waitForURL(new RegExp(`${catalog}/receipt`));
  const receipt = page.getByRole("main");
  await expect(page.getByRole("complementary")).toContainText("Sandbox demo · not a tax document");
  await expect(page.getByRole("complementary")).toContainText(/\$310\s*paid with PayPal/);
  await expect(receipt).toContainText("Wine Tasting");
  await expect(receipt).toContainText("Spa Day");
  await step(page, "11-receipt");

  // 10 after the close leads to 11 (B3).
  await page.goto(`${catalog}/paddle`);
  await page.waitForURL(new RegExp(`${catalog}/receipt`));

  // 14 on a phone: the board flows down the page, with the sold lots and the Sandbox demo marker.
  await page.goto(`${catalog}/projector`);
  await expect(page.getByText("Sandbox demo")).toBeVisible();
  await expect(page.getByRole("region", { name: "Raised tonight" })).toBeVisible();
  await expect(page.getByText("I bid for 1 guest")).toBeVisible();
  await step(page, "12-projector");

  // Insights (design/28), from the organizer's nav.
  await page.goto(`${catalog}/organizer`);
  await tap(page.getByRole("banner").getByRole("link", { name: "Insights" }));
  await page.waitForURL(new RegExp(`${catalog}/organizer/insights`));
  await expect(page.getByRole("region", { name: "Raised", exact: true })).toContainText("for Riverside Animal Shelter");
  await step(page, "13-insights");

  await kai.context().close();
});
