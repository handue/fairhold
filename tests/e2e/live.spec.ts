import { expect as baseExpect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import pg from "pg";

import { closeEvent } from "@/server/engine";
import { appendEventLog } from "@/server/sse/notify";

/**
 * 08 and 05 live, in real browsers, on a real demo gala: run against a server with no frozen clock.
 * Holds are written straight to the database as the PayPal store records them, because this is about
 * what a hold does to the page and not how it is approved. Every test starts its own demo.
 *
 *   DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/live.spec.ts
 */
test.use({ channel: "chrome", viewport: { width: 1440, height: 900 } });

/** A dev server compiles each route on first use, which can take longer than the default 5 seconds. */
const expect = baseExpect.configure({ timeout: 20_000 });

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
let shared: pg.Pool | null = null;
/** The worker's pool, made again after afterAll ended it: with fullyParallel, afterAll runs after each test. */
const pool = (): pg.Pool => (shared ??= new pg.Pool({ connectionString: databaseUrl, max: 3 }));

test.afterAll(async () => {
  const ending = shared;
  shared = null;
  await ending?.end();
});

async function startDemo(page: Page, firstName: string): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  // design/16 starts a demo with no name field; the API still takes one, so this spec's creator keeps its name.
  const started = await page.request.post("/api/demo", { data: { firstName: firstName } });
  await page.goto(((await started.json()) as { href: string }).href);
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname;
}

async function newGuest(browser: Browser, catalog: string, firstName: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${catalog}/join`, { waitUntil: "networkidle" });
  await page.getByLabel("First name").fill(firstName);
  await page.getByRole("button", { name: "Get my paddle" }).click();
  await page.waitForURL(catalog);
  return { context, page };
}

const slugOf = (catalog: string) => catalog.split("/").at(-1) ?? "";

async function paddle(catalog: string, firstName: string): Promise<{ id: string; eventId: string }> {
  const { rows } = await pool().query<{ id: string; event_id: string }>(
    `select p.id, p.event_id from paddles p join events e on e.id = p.event_id where e.slug = $1 and p.first_name = $2`,
    [slugOf(catalog), firstName],
  );
  const row = rows[0];
  if (!row) throw new Error(`No paddle for ${firstName}`);
  return { id: row.id, eventId: row.event_id };
}

/** The hold the PayPal return page would have authorized, on the paddle's live channel. */
async function hold(catalog: string, firstName: string, amountCents: number): Promise<void> {
  const { id, eventId } = await paddle(catalog, firstName);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       values ($1, $2, 'simulated', $3, 'authorized', now()) returning id`,
      [eventId, id, amountCents],
    );
    await appendEventLog(client, [
      { eventId, paddleId: id, type: "hold", payload: { holdId: rows[0]?.id ?? "", status: "authorized", amountCents } },
    ]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function openLot(page: Page, catalog: string, lotNumber = "07"): Promise<void> {
  await page.goto(`${catalog}/lots/${lotNumber}`, { waitUntil: "networkidle" });
}

const bidCard = (page: Page) => page.getByRole("region", { name: "Place a bid" });
/** The card's bid button: "Place bid", or "Bid again" once outbid (design/19 state 4). */
const placeBid = (page: Page) => bidCard(page).getByRole("button", { name: /^(Place bid|Bid again)/ });

/** The first preset's amount in dollars as the card shows it, e.g. "$340". */
async function nextMinimum(page: Page): Promise<string> {
  const text = await bidCard(page).getByRole("radio").first().innerText();
  return text.trim();
}

const dollars = (amount: string) => Number(amount.replace(/[$,]/g, ""));
const usd = (value: number) => `$${value.toLocaleString("en-US")}`;

/** In `page`: the wall-clock moment its bid card first shows `text`. */
function whenCardShows(page: Page, text: string): Promise<number> {
  return page.evaluate(
    (expected) =>
      new Promise<number>((resolve) => {
        const card = document.querySelector('section[aria-label="Place a bid"]');
        if (!card) throw new Error("No bid card");
        const check = () => {
          if (card.textContent?.includes(expected)) resolve(Date.now());
        };
        new MutationObserver(check).observe(card, { subtree: true, childList: true, characterData: true });
        check();
      }),
    text,
  );
}

/** In `page`: the wall-clock moment of the next click. */
function whenClicked(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        window.addEventListener("click", () => resolve(Date.now()), { capture: true, once: true });
      }),
  );
}

test.describe("a bid in one browser", () => {
  test("shows in a second browser within a second", async ({ page, browser }) => {
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 100_000);
    await hold(catalog, "Kai", 100_000);
    await Promise.all([openLot(page, catalog), openLot(guest.page, catalog)]);

    // The first bid warms the route; the dev server compiles it on first use.
    const opening = await nextMinimum(page);
    await placeBid(page).click();
    await expect(bidCard(page)).toContainText("You’re winning");
    await expect(bidCard(guest.page)).toContainText(opening);

    for (const [from, to] of [
      [guest.page, page],
      [page, guest.page],
    ] as const) {
      const amount = await nextMinimum(from);
      const seen = whenCardShows(to, amount);
      const clicked = whenClicked(from);
      await placeBid(from).click();
      const elapsed = (await seen) - (await clicked);
      expect(elapsed).toBeLessThan(1_000);
      await expect(bidCard(from)).toContainText("You’re winning");
      await expect(bidCard(to)).toContainText("You’re outbid");
    }
    await guest.context.close();
  });

  test("moves the other guest's whole lot page: price, count, presets, history and bidding power", async ({ page, browser }) => {
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 100_000);
    await hold(catalog, "Kai", 100_000);
    await Promise.all([openLot(page, catalog), openLot(guest.page, catalog)]);

    const amount = dollars(await nextMinimum(guest.page));
    await placeBid(guest.page).click();
    await expect(bidCard(guest.page)).toContainText("You’re winning");
    await expect(guest.page.getByRole("banner")).toContainText(`${usd(10_00 / 1 - amount)} / $1,000`.replace("$1000", "$1,000"));

    // Sam sees it with no reload, and the card offers the next amount.
    const card = bidCard(page);
    await expect(card.getByRole("radio").first()).not.toHaveText(usd(amount));
    await expect(card).toContainText(usd(amount));
    const history = page.getByRole("region", { name: "Bid history" }).getByRole("listitem").first();
    await expect(history).toContainText(usd(amount));
    await expect(history).not.toContainText("You");

    // Sam answers: the bidding power Sam's bid uses leaves Sam's pill, and Kai's comes back.
    const answer = dollars(await nextMinimum(page));
    await placeBid(page).click();
    await expect(page.getByRole("banner")).toContainText(`${usd(1_000 - answer)} / $1,000`);
    await expect(guest.page.getByRole("banner")).toContainText("$1,000 / $1,000");
    await expect(bidCard(guest.page)).toContainText("You’re outbid");
    await expect(page.getByRole("region", { name: "Bid history" }).getByRole("listitem").first()).toContainText("You");
    await guest.context.close();
  });
});

test.describe("08 lots", () => {
  test("flips a tile, the band's counts and the raised total, with no reload", async ({ page, browser }) => {
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 100_000);
    await hold(catalog, "Kai", 100_000);

    await page.goto(catalog, { waitUntil: "networkidle" });
    const band = page.getByRole("region", { name: "My paddle" });
    await expect(band).toContainText("Bidding power held with PayPal");
    await openLot(guest.page, catalog);

    // Sam bids on the lot page, and comes back to the lots.
    await openLot(page, catalog);
    await placeBid(page).click();
    await expect(bidCard(page)).toContainText("You’re winning");
    await page.goto(catalog, { waitUntil: "networkidle" });
    const tile = page.getByRole("article").filter({ hasText: "Lot 07" });
    await expect(tile).toContainText("You’re winning");
    await expect(band).toContainText("1 winning");
    const raised = page.getByText(/raised so far/).locator("..").locator("b");
    const raisedBefore = dollars(await raised.innerText());
    const tiles = await page.getByRole("article").allInnerTexts();

    // Kai outbids. Nothing is touched on Sam's page.
    const amount = dollars(await nextMinimum(guest.page));
    await placeBid(guest.page).click();

    await expect(tile).toContainText("You’re outbid");
    await expect(tile.getByRole("link", { name: "Bid again" })).toBeVisible();
    await expect(tile).toContainText(usd(amount));
    await expect(band).toContainText("1 outbid");
    await expect(raised).not.toHaveText(usd(raisedBefore));
    expect(dollars(await raised.innerText())).toBeGreaterThan(raisedBefore);

    // The tile changed where it stood: nothing moves under the cursor.
    const titles = (texts: string[]) => texts.map((text) => /Lot \d+/.exec(text)?.[0]);
    expect(titles(await page.getByRole("article").allInnerTexts())).toEqual(titles(tiles));
    await guest.context.close();
  });

  test("takes a new hold without a reload: the nav, then the band", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await page.goto(catalog, { waitUntil: "networkidle" });
    const nav = page.getByRole("banner");
    await expect(nav).toContainText("Not set");
    await expect(page.getByRole("region", { name: "My paddle" })).toHaveCount(0);
    const notSet = page.getByRole("region", { name: "Bidding power not set" });
    await expect(notSet).toContainText("Set your bidding power to start bidding");
    await expect(notSet.getByRole("link", { name: "Set bidding power" })).toHaveAttribute("href", `${catalog}/power`);

    await hold(catalog, "Sam", 50_000);

    await expect(nav).toContainText("$500 / $500");
    await expect(page.getByRole("region", { name: "My paddle" })).toContainText("Bidding power held with PayPal");
    await expect(notSet).toHaveCount(0);
  });

  test("closes tiles, the card and the event's pill when bidding closes", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await hold(catalog, "Sam", 100_000);
    await openLot(page, catalog);
    await placeBid(page).click();
    await expect(bidCard(page)).toContainText("You’re winning");

    const { eventId } = await paddle(catalog, "Sam");
    await closeEvent(eventId, { pool: pool() });

    await expect(bidCard(page)).toContainText(/Won at \d+:\d\d [AP]M/);
    await expect(bidCard(page).getByRole("button", { name: /Place bid/ })).toHaveCount(0);
    await expect(page.getByRole("banner")).toContainText(/Closed at/i);

    await page.goto(catalog, { waitUntil: "networkidle" });
    await expect(page.getByRole("article").filter({ hasText: "Lot 07" })).toContainText(/Won at/);
    await expect(page.getByRole("article").first()).toContainText(/Closed at|Won at/);
    // Nothing is left for Glim to bid on: 08's band leads to 11 instead.
    const band = page.getByRole("region", { name: "My paddle" });
    await expect(band.getByRole("link", { name: "See your receipt" })).toHaveAttribute("href", `${catalog}/receipt`);
    await expect(band.getByRole("button", { name: "Let Glim bid for me" })).toHaveCount(0);
  });
});

test.describe("05's bid card", () => {
  test("leads to 09 first when there is no bidding power (design/19 state 6)", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await openLot(page, catalog);

    await expect(placeBid(page)).toHaveCount(0);
    await expect(bidCard(page).getByRole("link", { name: "Set bidding power" })).toHaveAttribute(
      "href",
      new RegExp(`^${catalog}/power\\?next=${encodeURIComponent(`${catalog}/lots/07`)}$`),
    );
    await expect(bidCard(page)).toContainText("Bids are held with PayPal. You’re only charged if you win.");

    // A hold landing turns the card back into Place bid, without a reload.
    await hold(catalog, "Sam", 300_000);
    await expect(placeBid(page)).toBeVisible();
  });

  test("shows a bid past the bidding power with its numbers, and offers the raise that covers it (state 3)", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await hold(catalog, "Sam", 10_000);
    await openLot(page, catalog);
    const amount = await nextMinimum(page);

    await expect(placeBid(page)).toHaveCount(0);
    const notice = bidCard(page).getByRole("status");
    await expect(notice).toContainText(`This bid needs ${amount}`);
    await expect(notice).toContainText("You have $100 left of $100.");
    const raise = bidCard(page).getByRole("link", { name: "Raise bidding power" });
    await expect(raise).toHaveAttribute("href", new RegExp(`[?&]raise=${dollars(amount)}(&|$)`));
    await expect(bidCard(page)).toContainText("You’ll approve another hold in a PayPal window.");

    await raise.click();
    await page.waitForURL(/\/power\?/);
    await expect(page.getByRole("heading", { name: "Raise your bidding power" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Hold ${amount} with PayPal` })).toBeVisible();
  });

  test("keeps a picked preset while it is on offer, and drops it for the next minimum when it is not", async ({ page, browser }) => {
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 500_000);
    await hold(catalog, "Kai", 500_000);
    await Promise.all([openLot(page, catalog), openLot(guest.page, catalog)]);

    const card = bidCard(page);
    await card.getByRole("radio").nth(1).click();
    const picked = (await card.getByRole("radio").nth(1).innerText()).trim();
    await expect(placeBid(page)).toContainText(picked);

    // A rival takes the first preset: the pick is now the next minimum, still selected.
    await placeBid(guest.page).click();
    await expect(card.getByRole("radio").first()).toHaveText(picked);
    await expect(card.getByRole("radio").first()).toBeChecked();
    await expect(placeBid(page)).toContainText(picked);

    // Another bid passes it: the card falls back rather than climbing on its own.
    await bidCard(guest.page).getByRole("radio").nth(1).click();
    await placeBid(guest.page).click();
    await expect(card.getByRole("radio").first()).not.toHaveText(picked);
    const next = (await card.getByRole("radio").first().innerText()).trim();
    await expect(placeBid(page)).toContainText(next);
    await guest.context.close();
  });

  test("sets a max the engine answers rivals with, up to it", async ({ page, browser }) => {
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 300_000);
    await hold(catalog, "Kai", 300_000);
    await Promise.all([openLot(page, catalog), openLot(guest.page, catalog)]);

    const card = bidCard(page);
    const setMax = card.getByRole("button", { name: /Set max bid/ });
    await card.getByRole("radio", { name: "Max…" }).click();
    // Digits only: nothing else can be typed, and there is nothing to set yet.
    await card.getByLabel("Your max").pressSequentially("abc");
    await expect(card.getByLabel("Your max")).toHaveValue("");
    await expect(setMax).toBeDisabled();
    await expect(card).toContainText("automatically, up to your max.");

    await card.getByLabel("Your max").fill("2,000");
    await expect(card.getByLabel("Your max")).toHaveValue("$2,000");
    await expect(setMax).toContainText("$2,000");
    await expect(card).toContainText(/Outbid\? Your bid goes \$\d+ over theirs, automatically, up to \$2,000\./);
    await setMax.click();

    await expect(card).toContainText("You’re winning");
    await expect(placeBid(page)).toBeVisible();
    // The max stands, and the card keeps saying what it does.
    await expect(card).toContainText("automatically, up to $2,000.");

    // Kai bids; Sam's max answers at once and Sam stays on top.
    const first = dollars(await nextMinimum(guest.page));
    await placeBid(guest.page).click();
    await expect(bidCard(guest.page)).toContainText("You’re outbid");
    await expect(card).toContainText("You’re winning");
    await expect(page.getByRole("region", { name: "Bid history" }).getByRole("listitem").first()).toContainText("You");
    expect(dollars(await nextMinimum(guest.page))).toBeGreaterThan(first);
    await guest.context.close();
  });

  test("answers a max under the minimum with the minimum", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await hold(catalog, "Sam", 300_000);
    await openLot(page, catalog);
    const minimum = await nextMinimum(page);
    const card = bidCard(page);
    await card.getByRole("radio", { name: "Max…" }).click();
    await card.getByLabel("Your max").fill("1");
    await card.getByLabel("Your max").press("Enter");
    await expect(card.getByRole("alert")).toContainText(`Your max has to be at least ${minimum}.`);
    await expect(card.getByRole("button", { name: /Set max bid/ })).toBeDisabled();
  });

  test("sends a guest with no session to join, and back", async ({ page, context }) => {
    const catalog = await startDemo(page, "Sam");
    await hold(catalog, "Sam", 300_000);
    await openLot(page, catalog);
    await context.clearCookies();
    await placeBid(page).click();
    await page.waitForURL(new RegExp(`${catalog}/join\\?next=`));
    await expect(page.getByRole("button", { name: "Get my paddle" })).toBeVisible();
  });

  test("opens Glim from the agent link, with the lot", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await openLot(page, catalog);
    const opened = page.evaluate(
      () =>
        new Promise<unknown>((resolve) => {
          window.addEventListener("glim:open", (event) => resolve((event as CustomEvent).detail), { once: true });
        }),
    );
    await bidCard(page).getByRole("button", { name: "Let Glim bid on this lot" }).click();
    expect(await opened).toEqual({ lotNumber: 7, prefill: "Bid on Chef’s Table for me, up to $" });
  });
});

test.describe("the heart and the share button", () => {
  const heart = (page: Page) => page.getByRole("button", { name: "Save to my lots" });

  test("the heart answers at once, stays after a reload, and offers Glim on 08", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    await openLot(page, catalog);
    await expect(heart(page)).toHaveAttribute("aria-pressed", "false");

    const saved = page.waitForResponse((response) => response.url().endsWith("/lots/7/favorite"));
    await heart(page).click();
    await expect(heart(page)).toHaveAttribute("aria-pressed", "true");
    expect((await saved).status()).toBe(200);

    await page.reload({ waitUntil: "networkidle" });
    await expect(heart(page)).toHaveAttribute("aria-pressed", "true");

    await page.goto(catalog, { waitUntil: "networkidle" });
    await expect(page.getByRole("article").filter({ hasText: "Lot 07" }).getByRole("button", { name: "Let Glim watch" })).toBeVisible();

    await openLot(page, catalog);
    const cleared = page.waitForResponse((response) => response.url().endsWith("/lots/7/favorite"));
    await heart(page).click();
    await expect(heart(page)).toHaveAttribute("aria-pressed", "false");
    await cleared;
    await page.goto(catalog, { waitUntil: "networkidle" });
    await expect(page.getByRole("article").filter({ hasText: "Lot 07" }).getByRole("button", { name: "Let Glim watch" })).toHaveCount(0);
  });

  test("a heart in one tab reaches the guest's other tab", async ({ page, context }) => {
    const catalog = await startDemo(page, "Sam");
    await page.goto(catalog, { waitUntil: "networkidle" });
    const tile = page.getByRole("article").filter({ hasText: "Lot 07" });
    await expect(tile.getByRole("button", { name: "Let Glim watch" })).toHaveCount(0);

    const other = await context.newPage();
    await openLot(other, catalog);
    await heart(other).click();

    await expect(tile.getByRole("button", { name: "Let Glim watch" })).toBeVisible();
  });

  test("the share button copies the lot's link, where the browser has no share sheet", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "share", { value: undefined, configurable: true });
    });
    const catalog = await startDemo(page, "Sam");
    await openLot(page, catalog);

    await page.getByRole("button", { name: "Share this lot" }).click();

    await expect(page.getByRole("status")).toHaveText("LINK COPIED");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${baseURL}${catalog}/lots/07`);
    await expect(page.getByRole("status")).toHaveCount(0, { timeout: 5_000 });
  });

  test("the share button opens the browser's share sheet where it has one", async ({ page }) => {
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      (window as unknown as { shared: unknown[] }).shared = shared;
      Object.defineProperty(navigator, "share", {
        value: (data: unknown) => {
          shared.push(data);
          return Promise.resolve();
        },
        configurable: true,
      });
    });
    const catalog = await startDemo(page, "Sam");
    await openLot(page, catalog);
    await page.getByRole("button", { name: "Share this lot" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared.length)).toBe(1);
    const [data] = await page.evaluate(() => (window as unknown as { shared: { url: string; title: string }[] }).shared);
    expect(data?.url.endsWith(`${catalog}/lots/07`)).toBe(true);
  });
});

test.describe("the live connection", () => {
  test("opens one stream per tab, with the session's own rows, and none on a page that reads nothing", async ({ page }) => {
    const streams: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/api/stream")) streams.push(request.url());
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(streams).toHaveLength(0);
    await page.getByRole("button", { name: "Start a demo gala" }).click();
    await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => streams.length).toBe(1);
    expect(streams[0]).toContain(`slug=${slugOf(new URL(page.url()).pathname)}`);

    await page.getByRole("article").first().getByRole("link").first().click();
    await page.waitForURL(/\/lots\//);
    await expect(bidCard(page)).toBeVisible();
    expect(streams).toHaveLength(1);
  });

  test("falls back to polling when streams are blocked, and bids still arrive", async ({ page, browser }) => {
    test.slow();
    const catalog = await startDemo(page, "Sam");
    const guest = await newGuest(browser, catalog, "Kai");
    await hold(catalog, "Sam", 100_000);
    await hold(catalog, "Kai", 100_000);

    await page.route("**/api/stream?*", (route) => route.abort());
    await openLot(page, catalog);
    await openLot(guest.page, catalog);

    const polls = page.waitForRequest((request) => request.url().includes("/api/stream/poll"), { timeout: 60_000 });
    await polls;

    const amount = await nextMinimum(guest.page);
    await placeBid(guest.page).click();
    await expect(bidCard(guest.page)).toContainText("You’re winning");
    await expect(bidCard(page)).toContainText(amount, { timeout: 25_000 });
    await expect(page.getByRole("region", { name: "Bid history" }).getByRole("listitem").first()).toContainText(amount);
    await guest.context.close();
  });

  test("runs countdowns on the server's clock, whatever the browser's says", async ({ page }) => {
    const catalog = await startDemo(page, "Sam");
    const { rows } = await pool().query<{ seconds: number }>(
      `select extract(epoch from l.closes_at - now())::float8 as seconds
       from lots l join events e on e.id = l.event_id where e.slug = $1 and l.number = 7`,
      [slugOf(catalog)],
    );
    const expected = rows[0]?.seconds ?? 0;

    // A browser clock an hour and a half fast would read far past this lot's close.
    await page.clock.install({ time: new Date(Date.now() + 90 * 60_000) });
    await openLot(page, catalog);

    const reading = await bidCard(page).locator("span.font-mono").first().innerText();
    const [minutes = 0, seconds = 0] = reading.split(":").map(Number);
    expect(Math.abs(minutes * 60 + seconds - expected)).toBeLessThan(30);
  });
});
