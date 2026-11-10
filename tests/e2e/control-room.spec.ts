import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

/**
 * Screen 12 in a real browser with simulated payments: a demo gala closed through its demo control,
 * then charged from the control room. Needs a running database and a server with
 * PAYMENTS_MODE=simulated. Every test starts its own demo.
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=false npx next dev -p 3456
 *   PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/control-room.spec.ts
 */
test.use({ channel: "chrome" });
// A dev server compiles each route the first time it is asked for one.
test.setTimeout(120_000);

/** A client address of its own for each run of each test, so the limit on new demos per client stays out of this. */
test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.${octet()}.${octet()}.${octet()}` });
});

async function startDemo(page: Page, firstName = "Sam"): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  // design/16 starts a demo with no name field; the API still takes one, so this spec's creator keeps its name.
  const started = await page.request.post("/api/demo", { data: { firstName: firstName } });
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

/** Lot 22 has no bids in the Riverside story, so this bid wins it. */
async function winGolfLesson(page: Page, slug: string): Promise<void> {
  const bid = await page.request.post(`/api/events/${slug}/lots/22/bid`, { data: { amountCents: 7_500 } });
  expect(bid.status()).toBe(200);
}

async function closeBidding(page: Page, slug: string): Promise<void> {
  const closed = await page.request.post(`/api/events/${slug}/demo/close-bidding`, { data: {} });
  expect(closed.status()).toBe(200);
}

/** The rail, by its eyebrow: other asides (the demo guide) may share the page. */
const rail = (page: Page) => page.getByRole("complementary").filter({ hasText: /Bidding (open|closed)/ });
const grid = (page: Page) => page.getByRole("grid");

async function rowOf(page: Page, paddle: number) {
  await page.getByLabel("Search bidders or lots").fill(String(paddle));
  return grid(page).getByRole("row").filter({ hasText: String(paddle) }).first();
}

test("charges a demo: the real hold captured and labeled, the simulated guests labeled, and the CSV says which", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await winGolfLesson(page, slug);

  await page.goto(`/e/${slug}/organizer`);
  await expect(rail(page)).toContainText("Bidding open");
  await expect(rail(page).getByRole("button", { name: "Charge winners" })).toBeDisabled();
  await expect(page.getByRole("banner")).toContainText("Sam · Organizer");

  await closeBidding(page, slug);
  await page.reload();
  await expect(rail(page).getByRole("heading")).toHaveText("Ready to charge");
  // A simulated guest's hold is not called a PayPal hold.
  await expect(rail(page)).toContainText("The 85 simulated guests settle without PayPal.");
  await expect(rail(page)).toContainText("All passed", { timeout: 30_000 });
  await expect(rail(page)).toContainText("Every PayPal hold is still valid");

  const charge = rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ });
  await expect(charge).toBeEnabled();
  await charge.dblclick();

  await expect(rail(page).getByRole("heading")).toHaveText(/\d+ winners? charged/, { timeout: 30_000 });
  await expect(rail(page)).toContainText("Every hold is settled");
  await expect(rail(page)).toContainText("The 85 simulated guests settled without PayPal.");
  // Simulated payments made this charge's id up, so the rail never shows it under PayPal's name.
  await expect(rail(page)).toContainText(/PayPal transaction ID\s*Simulated/);
  await expect(rail(page)).not.toContainText("SIMC");
  await expect(rail(page).getByRole("button", { name: /Charge/ })).toHaveCount(0);

  await expect(await rowOf(page, 142)).toContainText("Charged");
  await expect(await rowOf(page, 88)).toContainText("Simulated");
  await page.getByLabel("Search bidders or lots").fill("");

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe(`settlement-ledger-${slug}.csv`);
  const csv = readFileSync(await download.path(), "utf8");
  expect(csv).toContain('"Paddle","Bidder","Hold","Lots won","Glim","Held","Charged","Released","Status","PayPal transaction ID"');
  expect(csv).toMatch(/"142","Sam","PayPal","Golf Lesson with a Pro","No","\$500","\$75","\$425","Charged","Simulated"/);
  expect(csv).toContain("Simulated, no PayPal");

  // The page stays right after a reload: this all came from the database.
  await page.reload();
  await expect(rail(page).getByRole("heading")).toHaveText(/\d+ winners? charged/);
});

test("filters, searches and pages the ledger", async ({ page }) => {
  const slug = await startDemo(page);
  await closeBidding(page, slug);
  await page.goto(`/e/${slug}/organizer`);
  await expect(grid(page).getByRole("row").nth(2)).toBeVisible();

  const footer = page.getByRole("main");
  await expect(footer).toContainText("Page 1 of");
  await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(footer).toContainText("Page 2 of");
  await page.getByRole("button", { name: "Previous page" }).click();

  await page.getByRole("tab", { name: /Won nothing/ }).click();
  await expect(page.getByRole("tab", { name: /Won nothing/ })).toHaveAttribute("aria-selected", "true");
  const chip = await page.getByRole("tab", { name: /Won nothing/ }).innerText();
  const count = /\d+/.exec(chip)?.[0];
  await expect(footer).toContainText(`of ${count}`);

  await page.getByRole("tab", { name: /^All/ }).click();
  await page.getByLabel("Search bidders or lots").fill("Rosa M");
  await expect(footer).toContainText("Showing 1 of 1");
  await expect(grid(page)).toContainText("Rosa M.");
});

test("design/24 §1: bidding open counts down, and Close bidding now on the rail ends it (C3)", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await page.goto(`/e/${slug}/organizer`);

  await expect(rail(page).getByRole("heading")).toHaveText(/^Closes in \d+:\d{2}$/);
  await expect(rail(page)).toContainText("When bidding closes");
  await expect(rail(page).getByRole("button", { name: "Charge winners" })).toBeDisabled();

  await rail(page).getByRole("button", { name: "Close bidding now" }).click();
  await expect(rail(page).getByRole("heading")).toHaveText("Ready to charge", { timeout: 30_000 });
  await expect(rail(page)).toContainText("All passed", { timeout: 30_000 });
  await expect(rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ })).toBeEnabled();
});

test("design/24 §5: a failed check names the hold, marks its row and keeps the charge off", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await winGolfLesson(page, slug);
  await closeBidding(page, slug);

  await page.route(`**/api/events/${slug}/settlement/checks`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        checks: {
          passed: false,
          ranAt: Date.now(),
          checks: [
            { key: "winners_within_holds", passed: true, count: 1, problems: [] },
            { key: "glim_within_limits", passed: true, count: 0, problems: [] },
            { key: "holds_valid", passed: false, count: 1, problems: [{ paddleNumber: 142, bidder: "Sam", code: "VOIDED", blocking: true }] },
          ],
        },
      }),
    }),
  );
  await page.goto(`/e/${slug}/organizer`);

  await expect(rail(page).getByRole("heading")).toHaveText("Can’t charge yet");
  await expect(rail(page)).toContainText("1 failed");
  await expect(rail(page)).toContainText("1 PayPal hold is no longer valid");
  await expect(rail(page)).toContainText("Paddle 142 · Sam. PayPal shows it as voided.");
  await expect(rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ })).toBeDisabled();
  await expect(rail(page).getByRole("button", { name: "Check again" })).toBeEnabled();
  await expect(await rowOf(page, 142)).toContainText("Not valid");
});

test("the rail never stays on Checking… when asking PayPal fails, and Check again asks afresh", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await closeBidding(page, slug);

  let failing = true;
  await page.route(`**/api/events/${slug}/settlement/checks`, (route) =>
    failing
      ? route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "not_joined", message: "Join this event first." } }) })
      : route.continue(),
  );
  await page.goto(`/e/${slug}/organizer`);

  await expect(rail(page)).toContainText("Not checked yet");
  await expect(rail(page)).not.toContainText("Checking…");
  await expect(rail(page).getByRole("alert")).toHaveText("Join this event first.");
  await expect(rail(page).getByRole("button", { name: /^Charge \d+ winners?$/ })).toBeDisabled();

  failing = false;
  await rail(page).getByRole("button", { name: "Check again" }).click();
  await expect(rail(page)).toContainText("All passed", { timeout: 30_000 });
  await expect(rail(page).getByRole("alert")).toHaveCount(0);
});

test("sends a guest away from the control room, and refuses their POST", async ({ page, browser }) => {
  const slug = await startDemo(page);

  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await guestContext.newPage();
  await guest.goto(`/e/${slug}/organizer`);
  await guest.waitForURL(new RegExp(`/e/${slug}/join`));
  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(new RegExp(`/e/${slug}(\\?.*)?$|/e/${slug}/organizer$`));

  await guest.goto(`/e/${slug}/organizer`);
  await guest.waitForURL(new RegExp(`/e/${slug}(\\?.*)?$`));
  const refused = await guest.request.post(`/api/events/${slug}/settlement`, { data: {} });
  expect(refused.status()).toBe(403);
  await guestContext.close();
});
