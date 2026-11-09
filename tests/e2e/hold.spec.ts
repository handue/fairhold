import { expect, test, type Browser, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";

/**
 * The hold from screen 09, in a real browser with simulated payments: approval is instant, so the
 * popup goes straight to the real return page and everything after it runs for real. Needs a
 * running database, and a server with PAYMENTS_MODE=simulated. Every test starts its own demo, so
 * each one has its own paddle 142 with no bidding power yet.
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=false npx next dev -p 3456
 *   PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/hold.spec.ts
 */
test.use({ channel: "chrome" });
// Each test goes through several pages, and a cold dev server compiles every one of them first.
test.describe.configure({ timeout: 60_000 });

/** A client address of its own for each test, so a production server's limit on new demos per client stays out of this. */
test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `203.${octet()}.${octet()}.${octet()}` });
});

async function startDemo(page: Page, firstName = "Sam"): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  // design/16 starts a demo with no name field; the API still takes one, so this spec's creator keeps its name.
  const started = await page.request.post("/api/demo", { data: { firstName: firstName } });
  await page.goto(((await started.json()) as { href: string }).href);
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname;
}

/** The stream keeps event pages from ever going network-idle, so wait for React itself. */
async function untilHydrated(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(() => locator.evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
}

async function openPower(page: Page, catalog: string, query = ""): Promise<Locator> {
  await page.goto(`${catalog}/power${query}`);
  // The amounts are radios, so this is the one button of the column, whatever it says right now.
  const hold = page.getByRole("main").getByRole("button");
  await untilHydrated(hold);
  return hold;
}

const nav = (page: Page) => page.getByRole("banner");

/** Keeps PayPal's window from coming back until `release` is called, as if the guest were still on PayPal's page. */
async function holdWindowOpen(context: BrowserContext): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/paypal/return?**", async (route: Route) => {
    await released;
    await route.continue();
  });
  return { release };
}

/** The window may be gone already: it closes itself, and quickly. */
async function untilClosed(popup: Page): Promise<void> {
  if (!popup.isClosed()) await popup.waitForEvent("close");
}

/** Sends PayPal's window to the cancel page, as if the guest had backed out there. */
async function cancelOnPayPal(context: BrowserContext): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    await route.fulfill({
      status: 302,
      headers: { location: route.request().url().replace("/paypal/return", "/paypal/cancel") },
    });
  };
  await context.route("**/paypal/return?**", handler);
  return () => context.unroute("**/paypal/return?**", handler);
}

test("holds $500 from the approved page: the nav flips, and the guest goes back to bid", async ({ page }) => {
  const catalog = await startDemo(page);
  await expect(nav(page)).toContainText("Not set");

  const hold = await openPower(page, catalog);
  await expect(page.getByRole("heading", { name: "Set your bidding power" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "$500" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Example: you win the Chef’s Table Dinner at $320")).toBeVisible();
  await expect(hold).toHaveText("Hold $500 with PayPal");

  const popupOpened = page.waitForEvent("popup");
  await hold.click();
  const popup = await popupOpened;
  // The window really goes through the return page, then closes itself.
  await untilClosed(popup);

  await expect(nav(page)).toContainText("$500 / $500");
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$500 / $500");
});

test("goes back to the lot the guest came from", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog, `?next=${encodeURIComponent(`${catalog}/lots/07`)}`);

  await hold.click();

  await page.waitForURL(`${catalog}/lots/07`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Chef’s Table Dinner for Four");
  await expect(nav(page)).toContainText("$500 / $500");
});

test("does not trust a next from another site", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog, `?next=${encodeURIComponent("https://evil.example/")}`);

  await hold.click();

  await page.waitForURL(catalog);
});

test("offers this tab when the browser blocks the window (design/17 frame 5)", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const hold = await openPower(page, catalog, `?next=${encodeURIComponent(`${catalog}/lots/07`)}`);

  await hold.click();

  await expect(hold).toHaveText("Continue to PayPal in this tab");
  await expect(page.getByText("Your browser blocked the PayPal window. You’ll come back here to bid.")).toBeVisible();
  await hold.click();

  // This tab goes to the return page, which says so and brings the guest back by itself.
  await page.waitForURL(/\/paypal\/return\?/);
  await expect(page.getByRole("heading", { name: "Approved" })).toBeVisible();
  await page.waitForURL(`${catalog}/lots/07`);
  await expect(nav(page)).toContainText("$500 / $500");
});

test("offers this tab when a blocker kills the window after opening it", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.addInitScript(() => {
    const open = window.open.bind(window);
    window.open = (...args) => {
      const popup = open(...args);
      setTimeout(() => popup?.close(), 0);
      return popup;
    };
  });
  const hold = await openPower(page, catalog);
  // Slow enough for the window to be gone by the time the answer comes.
  await page.route("**/api/holds/**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await hold.click();
  await expect(hold).toHaveText("Continue to PayPal in this tab");
  await hold.click();

  await page.waitForURL(/\/paypal\/return\?/);
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$500 / $500");
});

test("waits while the window is open, and offers this tab in case it was hidden", async ({ page, context }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);
  const { release } = await holdWindowOpen(context);

  await hold.click();

  await expect(hold).toHaveText("Finish in the PayPal window");
  await expect(hold).toBeDisabled();
  await expect(page.getByRole("radio", { name: "$250" })).toBeDisabled();
  await expect(page.getByText("Can’t change while the PayPal window is open")).toBeVisible();
  await expect(page.getByText("Nothing is held until you approve.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue in this tab" })).toHaveAttribute("href", /\/paypal\/return\?/);
  await expect(nav(page)).toContainText("Not set");

  release();

  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$500 / $500");
});

/** No message from the window reaches this page: as if PayPal's pages had cut it off from everything. */
async function silenceTheWindow(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BroadcastChannel", { value: undefined });
    const add = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: never[]) => {
      if (type !== "message") add(type, ...(rest as [never]));
    }) as typeof window.addEventListener;
  });
}

test("hears the hold from the stream when the window's messages never arrive", async ({ page }) => {
  const catalog = await startDemo(page);
  await silenceTheWindow(page);
  const hold = await openPower(page, catalog);

  await hold.click();

  await expect(nav(page)).toContainText("$500 / $500");
  await page.waitForURL(catalog);
});

test("hears the hold by polling when neither the window nor the stream gets through", async ({ page }) => {
  const catalog = await startDemo(page);
  await silenceTheWindow(page);
  await page.route("**/api/stream**", (route) => route.abort());
  const hold = await openPower(page, catalog);

  await hold.click();

  await page.waitForURL(catalog, { timeout: 15_000 });
  await expect(nav(page)).toContainText("$500 / $500");
});

test("says nothing was held after a cancel on PayPal, and tries again", async ({ page, context }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);
  const stopCanceling = await cancelOnPayPal(context);

  const popupOpened = page.waitForEvent("popup");
  await hold.click();
  // design/17 frame 4: the window stays to say so, until the guest closes it.
  const popup = await popupOpened;
  await popup.getByRole("button", { name: "Close window" }).click();
  await untilClosed(popup);

  const notice = page.getByRole("main").getByRole("status");
  await expect(notice).toContainText("Canceled in PayPal");
  await expect(notice).toContainText("Nothing was held.");
  await expect(nav(page)).toContainText("Not set");
  await expect(page).toHaveURL(new RegExp(`${catalog}/power$`));
  await expect(hold).toHaveText("Try again");
  await expect(hold).toBeEnabled();

  await stopCanceling();
  await hold.click();
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$500 / $500");
});

test("after a cancel in the redirect flow, lands back on bidding power to try again", async ({ page, context }) => {
  const catalog = await startDemo(page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const hold = await openPower(page, catalog, `?next=${encodeURIComponent(`${catalog}/lots/07`)}`);
  await cancelOnPayPal(context);

  await hold.click();
  await expect(hold).toHaveText("Continue to PayPal in this tab");
  await hold.click();

  await page.waitForURL(/\/paypal\/cancel\?/);
  await page.waitForURL((url) => url.pathname === `${catalog}/power`);
  expect(new URL(page.url()).searchParams.get("next")).toBe(`${catalog}/lots/07`);
  await expect(nav(page)).toContainText("Not set");
});

test("says so when PayPal could not start the hold, and closes the blank window", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);
  await page.route("**/api/holds/**", (route) =>
    route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "paypal_unavailable", message: "PayPal could not start this hold. Nothing was held. Please try again.", details: null },
      }),
    }),
  );

  const popupOpened = page.waitForEvent("popup");
  await hold.click();
  await untilClosed(await popupOpened);

  const notice = page.getByRole("main").getByRole("status");
  await expect(notice).toContainText("PayPal didn’t respond");
  await expect(notice).toContainText("Nothing was held.");
  await expect(hold).toHaveText("Try again");
  await expect(hold).toBeEnabled();

  // Another amount starts over.
  await page.getByRole("radio", { name: "$250" }).click();
  await expect(notice).toHaveCount(0);
  await expect(hold).toHaveText("Hold $250 with PayPal");
});

test("opens one window for a double click", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/api/holds/")) posts.push(request.url());
  });

  await hold.dblclick();

  await page.waitForURL(catalog);
  expect(posts).toHaveLength(1);
  await expect(nav(page)).toContainText("$500 / $500");
});

test("checks an Other… amount, with the explainer following it", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);

  await page.getByRole("radio", { name: "Other…" }).click();
  const amount = page.getByLabel("Other amount, in whole dollars");
  await expect(amount).toBeFocused();
  await expect(page.getByText("Whole dollars, $25 to $1,000.")).toBeVisible();
  await expect(hold).toHaveText("Hold with PayPal");
  await expect(hold).toBeDisabled();

  await amount.fill("1200");
  await expect(page.getByText("The most you can hold is $1,000.")).toBeVisible();
  await expect(hold).toBeDisabled();

  await amount.fill("10");
  await expect(page.getByText("The least you can hold is $25.")).toBeVisible();
  await expect(hold).toBeDisabled();

  // Digits only, so cents can't be typed.
  await amount.fill("750.50");
  await expect(amount).toHaveValue("$75,050");
  await amount.fill("750");
  await expect(amount).toHaveValue("$750");
  await expect(hold).toHaveText("Hold $750 with PayPal");
  await expect(page.getByText("Example: you win the Chef’s Table Dinner at $480")).toBeVisible();
  await expect(page.getByText("Never over $750")).toBeVisible();
  await expect(page.getByText("Win nothing? All $750 is released.")).toBeVisible();

  await hold.click();
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$750 / $750");
});

/**
 * An approved window closes itself after 3 seconds (design/17 frame 3). A hold pressed before then
 * reuses that window by name, and its close can land on the new hold's start, which reads as blocked.
 */
async function approvedWindowsClosed(page: Page): Promise<void> {
  await expect.poll(() => page.context().pages().filter((other) => other !== page && !other.isClosed()).length, { timeout: 10_000 }).toBe(0);
}

test("raises the hold from raise mode: a new total, offered only above the hold in place", async ({ page }) => {
  const catalog = await startDemo(page);
  await (await openPower(page, catalog)).click();
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$500 / $500");
  await approvedWindowsClosed(page);

  const hold = await openPower(page, catalog, "?raise");
  await expect(page.getByRole("heading", { name: "Raise your bidding power" })).toBeVisible();
  await expect(page.getByText("You have $500 held.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "$250" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "$500" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "$1,000" })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("Until you approve, your $500 hold stays as it is.")).toBeVisible();

  await page.getByRole("radio", { name: "Other…" }).click();
  const amount = page.getByLabel("Other amount, in whole dollars");
  await amount.fill("500");
  await expect(page.getByText("You already hold $500. Choose more than that.")).toBeVisible();
  await expect(hold).toBeDisabled();
  await amount.fill("600");

  await hold.click();
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$600 / $600");
  await approvedWindowsClosed(page);

  // At the event's maximum there is nothing left to raise to.
  await (await openPower(page, catalog)).click();
  await page.waitForURL(catalog);
  await expect(nav(page)).toContainText("$1,000 / $1,000");
  await page.goto(`${catalog}/power`);
  await expect(page.getByRole("heading", { name: "Your bidding power is at the top" })).toBeVisible();
  await expect(page.getByRole("button", { name: /with PayPal/ })).toHaveCount(0);
});

test("opens on the amount a link asks for, unless the rules refuse it", async ({ page }) => {
  const catalog = await startDemo(page);

  const onPreset = await openPower(page, catalog, "?amount=1000");
  await expect(page.getByRole("radio", { name: "$1,000" })).toHaveAttribute("aria-checked", "true");
  await expect(onPreset).toHaveText("Hold $1,000 with PayPal");

  const onOther = await openPower(page, catalog, "?amount=600");
  await expect(page.getByLabel("Other amount, in whole dollars")).toHaveValue("$600");
  await expect(onOther).toHaveText("Hold $600 with PayPal");

  const refused = await openPower(page, catalog, "?amount=5");
  await expect(page.getByRole("radio", { name: "$500" })).toHaveAttribute("aria-checked", "true");
  await expect(refused).toHaveText("Hold $500 with PayPal");
});

test("sends a visitor through join and back to bidding power", async ({ page, browser }) => {
  const catalog = await startDemo(page);

  const guest = await secondBrowser(browser);
  await guest.goto(`${catalog}/power`);
  await guest.waitForURL(/\/join\?next=/);
  await untilHydrated(guest.getByRole("button", { name: "Get my paddle" }));
  await guest.getByLabel("First name").fill("Kai");
  await guest.getByRole("button", { name: "Get my paddle" }).click();
  await guest.waitForURL(`${catalog}/power`);
  await expect(guest.getByRole("heading", { name: "Set your bidding power" })).toBeVisible();
  await expect(nav(guest)).toContainText("Kai");
  await expect(nav(guest)).toContainText("Not set");
  await guest.context().close();
});

test("flips the nav in another tab of the same guest, with no reload", async ({ page, context }) => {
  const catalog = await startDemo(page);
  const other = await context.newPage();
  await untilHydrated(await openPower(other, catalog));
  await expect(nav(other)).toContainText("Not set");

  await (await openPower(page, catalog)).click();

  await expect(nav(other)).toContainText("$500 / $500");
  await expect(other).toHaveURL(new RegExp(`${catalog}/power$`));
});

test("flips the nav on the lots and on a lot in other tabs, through the stream", async ({ page, context }) => {
  const catalog = await startDemo(page);
  const lots = await context.newPage();
  await lots.goto(catalog);
  await expect(nav(lots)).toContainText("Not set");
  const lot = await context.newPage();
  await lot.goto(`${catalog}/lots/07`);
  await expect(nav(lot)).toContainText("Not set");

  await (await openPower(page, catalog)).click();

  await expect(nav(lots)).toContainText("$500 / $500");
  await expect(nav(lot)).toContainText("$500 / $500");
  await expect(lots).toHaveURL(new RegExp(`${catalog}$`));
});

test("turns another tab into raise mode when a hold lands, offering only what is still possible", async ({ page, context }) => {
  const catalog = await startDemo(page);
  const other = await context.newPage();
  const otherHold = await openPower(other, catalog);

  await (await openPower(page, catalog)).click();
  await page.waitForURL(catalog);

  await expect(other.getByRole("heading", { name: "Raise your bidding power" })).toBeVisible();
  await expect(other.getByRole("radio", { name: "$500" })).toHaveCount(0);
  await expect(other.getByRole("radio", { name: "$1,000" })).toHaveAttribute("aria-checked", "true");
  await expect(otherHold).toHaveText("Hold $1,000 with PayPal");
});

test("offers nothing to hold once bidding has closed, on a page already open too", async ({ page }) => {
  const catalog = await startDemo(page);
  const hold = await openPower(page, catalog);

  const closed = await page.request.post(`/api/events${catalog.replace(/^\/e/, "")}/demo/close-bidding`);
  expect(closed.ok()).toBe(true);

  await expect(page.getByRole("heading", { name: "Bidding has closed" })).toBeVisible();
  await expect(hold).toHaveCount(0);
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to the lots" })).toHaveAttribute("href", catalog);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Bidding has closed" })).toBeVisible();
});

test("shows the server's reason when a window cannot open, and closes the blank one", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.route("**/api/holds/**", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "bidding_ended", message: "Bidding has closed for this event.", details: null } }),
    }),
  );
  const hold = await openPower(page, catalog);

  const popupOpened = page.waitForEvent("popup");
  await hold.click();
  await untilClosed(await popupOpened);

  await expect(page.getByText("Bidding has closed for this event.")).toBeVisible();
  await expect(nav(page)).toContainText("Not set");
});

async function secondBrowser(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  return context.newPage();
}
