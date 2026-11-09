import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * Getting in, on the plain stand-ins for design/16 and design/16b: a demo from the home page, and a
 * second browser joining it. Needs a running database; every test starts its own demo.
 */
test.use({ channel: "chrome" });

async function startDemo(page: Page, firstName: string): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("First name").fill(firstName);
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname;
}

/** A browser with no cookies: another guest's. */
async function secondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

test("starts a demo gala from the home page, as paddle 142 with no bidding power yet", async ({ page }) => {
  await startDemo(page, "Sam");

  const nav = page.getByRole("banner");
  await expect(nav).toContainText("Riverside Shelter Gala");
  await expect(nav).toContainText("Sam");
  await expect(nav).toContainText("142");
  await expect(nav).toContainText("Not set");
  await expect(page.getByRole("heading", { name: "Tonight’s lots" })).toBeVisible();
  await expect(page.getByText("Show 16 more lots")).toBeVisible();
});

test("asks again for a name it cannot use", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByLabel("First name").fill("   ");
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await expect(page.getByText("Enter a first name of up to 40 characters.")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("sends a second browser through join to the next paddle, and keeps the creator's", async ({ page, browser }) => {
  const catalog = await startDemo(page, "Sam");

  const guest = await secondBrowser(browser);
  await guest.goto(catalog, { waitUntil: "networkidle" });
  await guest.waitForURL(`${catalog}/join`);
  await expect(guest.getByRole("heading", { name: "Riverside Shelter Gala" })).toBeVisible();

  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(catalog);
  const nav = guest.getByRole("banner");
  await expect(nav).toContainText("Kai");
  await expect(nav).not.toContainText("142");

  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("banner")).toContainText("Sam");
  await expect(page.getByRole("banner")).toContainText("142");
  await guest.context().close();
});

test("brings a guest who followed a lot's link back to that lot after joining", async ({ page, browser }) => {
  const catalog = await startDemo(page, "Sam");

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
  const catalog = await startDemo(page, "Sam");
  await page.goto(`${catalog}/join`, { waitUntil: "networkidle" });
  await page.waitForURL(catalog);
  await expect(page.getByRole("banner")).toContainText("142");
});
