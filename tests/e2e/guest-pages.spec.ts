import { expect, test, type Page } from "@playwright/test";

/**
 * Screens 08 and 05 against the approved Jamie state: run with the seeded fixture event, or with
 * a dev server started with UI_FIXTURE=riverside. Uses the installed Google Chrome.
 */
test.use({ channel: "chrome" });

const CATALOG = "/e/riverside-shelter-gala";
const CHEFS_TABLE = `${CATALOG}/lots/07`;

/** Waits for the page's scripts too, so clicks land after hydration. */
async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle" });
}

test.describe("08 lots", () => {
  test("shows Jamie's bidding power, bids and the raised total", async ({ page }) => {
    await open(page, CATALOG);

    const nav = page.getByRole("banner");
    await expect(nav).toContainText("Riverside Shelter Gala");
    await expect(nav).toContainText(/Live · Closes 9:30 PM/i);
    await expect(nav).toContainText("$180 / $500");
    await expect(nav).toContainText("Jamie");

    const band = page.getByRole("region", { name: "My paddle" });
    await expect(band).toContainText("Bidding power held with PayPal");
    await expect(band).toContainText("1 winning");
    await expect(band).toContainText("1 outbid");

    await expect(page.getByRole("heading", { name: "Tonight’s lots" })).toBeVisible();
    await expect(page.getByText("raised so far for Riverside Animal Shelter")).toBeVisible();
  });

  test("puts Jamie's lots first and reveals the other sixteen", async ({ page }) => {
    await open(page, CATALOG);

    const tiles = page.getByRole("article");
    await expect(tiles).toHaveCount(8);
    await expect(tiles.nth(0)).toContainText("Chef’s Table Dinner for Four");
    await expect(tiles.nth(0)).toContainText("You’re winning");
    await expect(tiles.nth(1)).toContainText("You’re outbid");
    await expect(tiles.nth(1).getByRole("link", { name: "Bid again" })).toBeVisible();
    await expect(tiles.nth(2).getByRole("button", { name: "Let Glim watch" })).toBeVisible();

    await page.getByRole("button", { name: "Show 16 more lots" }).click();
    await expect(tiles).toHaveCount(24);
  });

  test("filters by category", async ({ page }) => {
    await open(page, CATALOG);
    await page.getByRole("navigation", { name: "Categories" }).getByRole("link", { name: "Dining" }).click();

    await expect(page).toHaveURL(/category=dining/);
    await expect(page.getByRole("article")).toHaveCount(5);
  });

  test("opens a lot from its tile", async ({ page }) => {
    await open(page, CATALOG);
    await page.getByRole("link", { name: "Chef’s Table Dinner for Four" }).click();

    await expect(page).toHaveURL(/\/lots\/07/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chef’s Table Dinner for Four");
  });
});

test.describe("05 lot detail", () => {
  test("shows the bid card with presets that drive Place bid", async ({ page }) => {
    await open(page, CHEFS_TABLE);

    await expect(page.getByText("Donated by Oak & Ember · Estimated value $480")).toBeVisible();
    const card = page.getByRole("region", { name: "Place a bid" });
    await expect(card).toContainText("You’re winning");
    await expect(card).toContainText("$320");
    await expect(card).toContainText("12 bids");

    const placeBid = card.getByRole("button", { name: /Place bid/ });
    await expect(placeBid).toHaveText(/Place bid\s*\$340/);
    await card.getByRole("radio", { name: "$400" }).click();
    await expect(placeBid).toHaveText(/Place bid\s*\$400/);
  });

  test("lists the latest bids, Jamie's tagged", async ({ page }) => {
    await open(page, CHEFS_TABLE);

    const rows = page.getByRole("region", { name: "Bid history" }).getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("Paddle 142");
    await expect(rows.nth(0)).toContainText("You");
    await expect(rows.nth(1)).toContainText("Paddle 088");
  });

  test("answers an unknown lot with a 404 page", async ({ page }) => {
    await open(page, `${CATALOG}/lots/99`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
  });
});
