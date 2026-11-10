import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * Insights (design/28) in a real browser: a demo gala's "Tonight" report, its widgets, and the AG Grid
 * that carries the lots (sorting, a column filter, CSV). Needs a running database and a server with
 * PAYMENTS_MODE=simulated. Every test starts its own demo.
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=false npx next dev -p 3456
 *   PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/insights.spec.ts
 */
test.use({ channel: "chrome", viewport: { width: 1440, height: 900 } });
test.setTimeout(120_000);

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.${octet()}.${octet()}.${octet()}` });
});

async function startDemo(page: Page): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  // design/16 starts a demo with no name field; the API still takes one, so this spec's creator keeps its name.
  const started = await page.request.post("/api/demo", { data: { firstName: "Sam" } });
  await page.goto(((await started.json()) as { href: string }).href);
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname.split("/").pop() ?? "";
}

/** $500 of bidding power: in simulated mode the approval link is the return page itself. */
async function holdFiveHundred(page: Page, slug: string): Promise<void> {
  const created = await page.request.post(`/api/holds/${slug}`, { data: { amountCents: 50_000, next: `/e/${slug}` } });
  expect(created.ok()).toBe(true);
  const { approvalUrl } = (await created.json()) as { approvalUrl: string };
  await page.goto(approvalUrl);
}

const widget = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
const topLots = (page: Page) => widget(page, "Top lots").getByRole("grid");

test("reports tonight on a demo, live, with its widgets and a sortable, filterable lots grid", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await page.goto(`/e/${slug}/organizer/insights`);

  await expect(page.getByRole("heading", { name: "Tonight" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("85 of the 86 bidders are simulated guests.");
  await expect(widget(page, "Raised")).toContainText("for Riverside Animal Shelter");
  await expect(widget(page, "Lots sold")).toContainText("still open");
  await expect(widget(page, "Limits kept")).toContainText("limits");
  await expect(widget(page, "Hold utilization")).toContainText("held is bid now");
  await expect(widget(page, "Raised through the evening").getByRole("img")).toHaveAttribute("aria-label", /^Raised through the evening, from \$0/);

  // Five rows, ranked by the high bid; a header click ranks every lot with bids by its bids instead.
  const rows = topLots(page).locator(".ag-row");
  await expect(rows).toHaveCount(5);
  await topLots(page).getByRole("columnheader", { name: "Bids" }).click();
  await expect(topLots(page).getByRole("columnheader", { name: "Bids" })).toHaveAttribute("aria-sort", "descending");
  const bids = await rows.locator('[col-id="bids"]').allInnerTexts();
  expect(bids.map(Number)).toEqual([...bids.map(Number)].sort((a, b) => b - a));

  // The title's own filter, from the header.
  await topLots(page).getByRole("columnheader", { name: "Title" }).hover();
  await topLots(page).getByRole("columnheader", { name: "Title" }).locator(".ag-header-cell-filter-button").click();
  await page.locator(".ag-filter input").first().fill("Cabin");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Weekend Cabin Stay");
  await page.keyboard.press("Escape");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`insights-lots-${slug}.csv`);
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv).toContain('"Lot","Title","High bid","Estimated value","Bids","Paddle","Glim"');
  expect(csv).toContain('"Weekend Cabin Stay"');
});

test("is the organizer's: a guest is sent to the lots", async ({ page, browser }) => {
  const slug = await startDemo(page);
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(`/e/${slug}/join`);
  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(new RegExp(`/e/${slug}(\\?.*)?$`));
  await guest.goto(`/e/${slug}/organizer/insights`);
  await guest.waitForURL(new RegExp(`/e/${slug}(\\?.*)?$`));
  await guestContext.close();
});
