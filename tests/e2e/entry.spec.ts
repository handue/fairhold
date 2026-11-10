import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Getting in (design/16, 16b, 16c), the role menu and demo controls (design/18) and the navs
 * (design/27). Needs a running database; every test starts its own demo.
 *
 *   NEXT_DIST_DIR=.next-entry PAYMENTS_MODE=simulated GLIM_MODE=recorded npx next dev -p 3461
 *   PLAYWRIGHT_BASE_URL=http://localhost:3461 npx playwright test tests/e2e/entry.spec.ts
 */
test.use({ channel: "chrome" });
test.setTimeout(90_000);

const nav = (page: Page) => page.getByRole("banner");
const GALA = /\/e\/gala-[0-9a-z]{16}$/;

async function startDemo(page: Page): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(GALA);
  return new URL(page.url()).pathname;
}

/** A browser with no cookies: another guest's. */
async function secondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/**
 * A browser whose page never hydrates: React's code never loads, while the page's own inline
 * scripts still show what streams in. Pressing a button now is what a guest does before hydration.
 */
async function neverHydrates(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route(/\/_next\/static\/.*\.js(\?|$)/, (route) => route.abort());
  return context;
}

test("starts a demo gala from the home page's one button, as Jamie with paddle 142", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Put bidding power on hold.Pay only for what you win.");
  await expect(page.getByText("Private 25-minute gala · 24 lots · simulated guests · PayPal sandbox, no real money")).toBeVisible();
  await expect(page.getByText("Sandbox demo")).toBeVisible();
  await expect(page.getByLabel("First name")).toHaveCount(0);

  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(GALA);
  await expect(nav(page)).toContainText("Jamie");
  await expect(nav(page)).toContainText("142");
  await expect(nav(page)).toContainText("Not set");
  await expect(nav(page)).toContainText("Sandbox demo", { ignoreCase: true });
  await expect(page.getByRole("heading", { name: "Tonight’s lots" })).toBeVisible();
});

test("starts a demo with scripts off: the form posts itself and the server answers with the session", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(GALA);
  const slug = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const cookies = await context.cookies();
  expect(cookies.find((cookie) => cookie.name === `fh_s_${slug}`)).toMatchObject({ httpOnly: true, sameSite: "Lax" });
  await context.close();
});

test("joins before the page hydrates, keeping the name typed", async ({ page, browser }) => {
  const catalog = await startDemo(page);
  const context = await neverHydrates(browser);
  const guest = await context.newPage();
  await guest.goto(`${catalog}/join`);
  await expect(guest.getByRole("heading", { name: "You’re invited" })).toBeVisible();

  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(catalog);
  await expect(nav(guest)).toContainText("Kai");
  await context.close();
});

test("asks again for a name it cannot use, and keeps what was typed", async ({ page, browser }) => {
  const catalog = await startDemo(page);
  const guest = await secondBrowser(browser);
  await guest.goto(`${catalog}/join`, { waitUntil: "networkidle" });
  await guest.getByLabel("First name").fill("   ");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await expect(guest.getByRole("main").getByRole("alert")).toHaveText("Enter a first name of up to 40 characters.");
  await expect(guest.getByLabel("First name")).toHaveValue("   ");
  await expect(guest).toHaveURL(new RegExp(`${catalog}/join$`));
  await guest.context().close();
});

test("sends a second browser through 16b to the next paddle, and keeps the creator's", async ({ page, browser }) => {
  const catalog = await startDemo(page);

  const guest = await secondBrowser(browser);
  await guest.goto(catalog, { waitUntil: "networkidle" });
  await guest.waitForURL(`${catalog}/join`);
  await expect(guest.getByRole("heading", { name: "You’re invited" })).toBeVisible();
  await expect(guest.getByText("Join Riverside Shelter Gala and bid on tonight’s 24 lots.")).toBeVisible();
  await expect(guest.getByText("Your winning bids support Riverside Animal Shelter.")).toBeVisible();
  await expect(guest.getByText("Next, you’ll set your bidding power with PayPal, then bid.")).toBeVisible();
  await expect(guest.getByText("Riverside Shelter Gala · runs on")).toBeVisible();

  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(catalog);
  await expect(nav(guest)).toContainText("Kai");
  await expect(nav(guest)).not.toContainText("142");
  // An invited guest gets the plain pill: the role menu is the creator's.
  await expect(nav(guest).getByRole("button", { name: /Kai/ })).toHaveCount(0);

  await page.reload({ waitUntil: "networkidle" });
  await expect(nav(page)).toContainText("Jamie");
  await expect(nav(page)).toContainText("142");
  await guest.context().close();
});

test("brings a guest who followed a lot's link back to that lot after joining", async ({ page, browser }) => {
  const catalog = await startDemo(page);

  const guest = await secondBrowser(browser);
  await guest.goto(`${catalog}/lots/07`, { waitUntil: "networkidle" });
  await guest.waitForURL(/\/join\?next=/);
  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(`${catalog}/lots/07`);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText("Chef’s Table Dinner for Four");
  await guest.context().close();
});

test("skips the join page for a browser that already has its paddle", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.goto(`${catalog}/join`, { waitUntil: "networkidle" });
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("142");
});

test("every nav link goes to a real page (design/27)", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.waitForLoadState("networkidle");
  const links = nav(page).getByRole("navigation");
  await expect(links.getByRole("link")).toHaveText(["Lots", "My paddle"]);
  await expect(links.getByRole("link", { name: "My paddle" })).toHaveAttribute("href", `${catalog}/paddle`);
  await expect(nav(page).getByText("How it works")).toHaveCount(0);

  await page.goto(`${catalog}/organizer`, { waitUntil: "networkidle" });
  const organizer = nav(page).getByRole("navigation", { name: "Organizer" });
  await expect(organizer.getByRole("link")).toHaveText(["Control room", "Insights", "Projector"]);
  await expect(organizer.getByRole("link", { name: "Insights" })).toHaveAttribute("href", `${catalog}/organizer/insights`);
  await expect(organizer.getByRole("link", { name: "Projector" })).toHaveAttribute("href", `${catalog}/projector`);
});

test("the creator's role menu runs the demo controls and shows what they answer (design/18)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const catalog = await startDemo(page);
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("complementary", { name: "Demo guide" })).toContainText("Step 1 of 5");

  const pill = nav(page).getByRole("button", { name: /142/ });
  await pill.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitemradio", { name: "Guest view" })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitem")).toHaveText(["Close next lot", "Close bidding now", "Add 10 minutes", "Invite a guest", "Reset demo"]);

  await menu.getByRole("menuitem", { name: "Invite a guest" }).click();
  const invite = page.getByRole("dialog");
  await expect(invite).toContainText(`${catalog}/join`);
  await invite.getByRole("button", { name: "Copy the invite link" }).click();
  await expect(invite).toContainText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`${catalog}/join$`));
  await page.keyboard.press("Escape");

  await pill.click();
  await page.getByRole("menuitem", { name: "Add 10 minutes" }).click();
  await expect(page.getByRole("dialog")).toContainText(/Bidding now closes at \d{1,2}:\d{2} [AP]M\./);

  await pill.click();
  await page.getByRole("menuitem", { name: "Close next lot" }).click();
  await expect(page.getByRole("dialog")).toContainText(/Lot \d{2}, .+, is closed\. 23 lots are still open\./);

  await pill.click();
  await page.getByRole("menuitemradio", { name: "Organizer view" }).click();
  await page.waitForURL(`${catalog}/organizer`);
  const organizerPill = nav(page).getByRole("button", { name: /Organizer/ });
  await organizerPill.click();
  await expect(page.getByRole("menuitemradio", { name: "Organizer view" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitem", { name: "Close bidding now" }).click();
  await expect(page.getByRole("dialog")).toContainText("Bidding is closed.");

  // The route's refusal, in the same card.
  await organizerPill.click();
  await page.getByRole("menuitem", { name: "Add 10 minutes" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Bidding has closed for this event.");
  await page.keyboard.press("Escape");

  // Reset lands this browser in a new gala, and the old one's link says it ended (design/16c).
  await organizerPill.click();
  await page.getByRole("menuitem", { name: "Reset demo" }).click();
  await page.waitForURL((url) => GALA.test(url.pathname) && url.pathname !== catalog);
  await expect(nav(page)).toContainText("142");

  await page.goto(catalog, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "This demo gala has ended" })).toBeVisible();
  await expect(page.getByText("Any open holds were released")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start a new demo gala" })).toBeVisible();
});

test("a gala that is gone shows 16c, and its button starts a new one", async ({ page }) => {
  await page.goto("/e/gala-0000000000000000", { waitUntil: "networkidle" });
  await expect(page.getByText("Link expired")).toBeVisible();
  await expect(page.getByRole("heading", { name: "This demo gala has ended" })).toBeVisible();
  await expect(page.getByText("It ran in the PayPal sandbox, so no real money moved.")).toBeVisible();
  await page.getByRole("button", { name: "Start a new demo gala" }).click();
  await page.waitForURL(GALA);
  await expect(nav(page)).toContainText("142");
});

test("shows the sandbox buyer's email, and keeps the password out of the page's text", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const buyer = page.getByRole("region", { name: "PayPal sandbox buyer" });
  test.skip((await buyer.count()) === 0, "Needs DEMO_BUYER_1_EMAIL and DEMO_BUYER_1_PASSWORD on the server");
  await expect(buyer.getByLabel("Password, hidden")).toHaveText("••••••••••");
  await expect(buyer.getByRole("button", { name: "Copy the sandbox buyer’s password" })).toBeVisible();
  await expect(buyer.getByRole("button", { name: "Copy the sandbox buyer’s email" })).toBeVisible();
});

test("16's showcase panel is the board's 516px, with 52px around its content, with or without the buyer card", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  const panel = page.getByRole("complementary", { name: "How a guest bids" });
  const box = await panel.boundingBox();
  const band = await panel.getByText("$500 held with PayPal").locator("xpath=ancestor::div[contains(@class,'bg-ink')][1]").boundingBox();
  const pill = await panel.getByText("You’re winning").boundingBox();
  if (!box || !band || !pill) throw new Error("the showcase did not render");
  // design/16: the panel is 516px tall, its band 51.5px below its top, the pill 51.5px above its bottom.
  expect(box.height).toBeGreaterThanOrEqual(515);
  expect(box.height).toBeLessThanOrEqual(517);
  expect(Math.abs(band.y - box.y - 51.5)).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height - (pill.y + pill.height) - 51.5)).toBeLessThanOrEqual(1.5);
});
