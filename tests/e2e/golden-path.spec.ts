import { expect as baseExpect, test, type Browser, type Page } from "@playwright/test";

/**
 * The whole path in real browsers, on the real tick and the real clock: a demo from the home page, the
 * nav's pill to 09, a hold through the window, a bid a second browser sees, the golden sentence, Start
 * bidding, the director's rivals, then the control room charging. The autopilot's switch is off in the
 * shipped code, so Glim stops at the card's limits here; tests/integration/seams/golden-path.test.ts
 * covers its move. Closing has no control yet (design/18), so that one step goes through its route.
 *
 * The rivals need the tick, so this runs only when asked, against a server with the same setting:
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=true npx next dev -p 3456
 *   ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/golden-path.spec.ts
 */
test.use({ channel: "chrome" });
// The rivals alone take up to about 95 seconds, and a cold dev server compiles every page first.
test.setTimeout(240_000);

const expect = baseExpect.configure({ timeout: 30_000 });

const GOLDEN_SENTENCE = "$500. I really want the chef’s dinner. Spa only under $120.";

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `192.${octet()}.${octet()}.${octet()}` });
});

const nav = (page: Page) => page.getByRole("banner");
const bidCard = (page: Page) => page.getByRole("region", { name: "Place a bid" });

async function secondGuest(browser: Browser, catalog: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${catalog}/join`);
  await page.getByLabel("First name").fill("Kai");
  await page.getByRole("button", { name: "Get my paddle" }).click();
  await page.waitForURL(catalog);
  return page;
}

test("from a new demo to the winners charged", async ({ page, browser }) => {
  test.skip(process.env.ENGINE_ENABLED !== "true", "Needs a server with ENGINE_ENABLED=true, and the same setting here");

  // A demo from the home page: paddle 142, nothing held.
  await page.goto("/");
  await page.getByLabel("First name").fill("Jamie");
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  const catalog = new URL(page.url()).pathname;
  const slug = catalog.split("/").at(-1) ?? "";
  await expect(nav(page)).toContainText("Not set");

  // Kai watches from a browser of his own.
  const kai = await secondGuest(browser, catalog);

  // The nav's pill leads to 09; the hold goes through the window, and the guest comes back.
  await nav(page).getByRole("link", { name: /Bidding power/ }).click();
  await page.waitForURL(`${catalog}/power`);
  const hold = page.getByRole("main").getByRole("button", { name: "Hold $500 with PayPal" });
  await expect(hold).toBeEnabled();
  await expect
    .poll(() => hold.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
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

  // A bid over what is left is refused with its reason.
  await page.goto(`${catalog}/lots/03`);
  await bidCard(page).getByRole("button", { name: /Place bid/ }).click();
  await expect(page.getByText(/you have \$180 left of \$500/)).toBeVisible();

  // The golden sentence, the card, and Start bidding.
  await page.goto(`${catalog}/lots/07`);
  await page.getByRole("button", { name: "Chat with Glim" }).click();
  const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
  await panel.getByLabel("Message Glim").fill(GOLDEN_SENTENCE);
  await panel.getByRole("button", { name: "Send" }).click();
  await expect(panel.getByText("My plan for you")).toBeVisible();
  await expect(panel.getByText("$380")).toBeVisible();
  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByText("I bid $90 for you. I’ll go up to $120.")).toBeVisible();

  // The director's rivals, on the real tick, into the open panel.
  await expect(panel.getByText("Someone bid $360. I raised to $380, your limit for this lot.")).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByText("Someone bid $400, over your $380 limit.")).toBeVisible({ timeout: 90_000 });

  // Close and charge from the control room. Only Spa Day was won.
  const closed = await page.request.post(`/api/events/${slug}/demo/close-bidding`, { data: {} });
  expect(closed.status()).toBe(200);
  await page.goto(`${catalog}/organizer`);
  const rail = page.getByRole("complementary");
  await expect(rail).toContainText("All passed");
  await rail.getByRole("button", { name: /^Charge \d+ winners?$/ }).click();
  await expect(rail.getByRole("heading")).toHaveText(/\d+ winners? charged/);
  await page.getByLabel("Search bidders or lots").fill("142");
  const row = page.getByRole("grid").getByRole("row").filter({ hasText: "142" }).first();
  await expect(row).toContainText("Charged");
  await expect(row).toContainText("$90");
  await expect(row).toContainText("$410");

  await kai.context().close();
});
