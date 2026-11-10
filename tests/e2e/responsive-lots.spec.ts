import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type BrowserContext, type Locator, type Page, type Route } from "@playwright/test";
import pg from "pg";

import { closeEvent } from "@/server/engine";
import { highestHoldCents, resolveHoldLimits } from "@/server/holds/rules";
import { appendEventLog } from "@/server/sse/notify";

import { atWidth, expectNoClippedText, expectNoHorizontalOverflow, WIDTHS, type Width } from "./support/responsive";

/**
 * The bidding pages below the approved 1440: 08 the lots, 05 a lot with every bid card state, and 09
 * bidding power with frames 7 to 12. Each state is set up once, then checked at every width in WIDTHS:
 * nothing reaches past the viewport, no text is cut off, and at 375 the state's primary actions are
 * big enough for a thumb. Jamie's states come from the seeded fixture (?paddle=142); the rest start
 * their own demo, as lot-states and hold do.
 *
 *   DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/responsive-lots.spec.ts
 *
 * RESPONSIVE_SHOTS=<dir> also saves a full-page capture of each state at 320, 375, 768, 1024 and 1280
 * (RESPONSIVE_SHOT_WIDTHS=1440,375 picks others; 1440 is captured at 1440x900). RESPONSIVE_SHOTS_ONLY=1
 * skips the checks, for capturing the approved 1440 before a change to compare with after it.
 */
test.use({ channel: "chrome" });
test.describe.configure({ timeout: 180_000 });

const expect = baseExpect.configure({ timeout: 20_000 });

const FIXTURE = "/e/riverside-shelter-gala";
const JAMIE = "?paddle=142";
const SHOTS = process.env.RESPONSIVE_SHOTS ?? null;
const SHOTS_ONLY = process.env.RESPONSIVE_SHOTS_ONLY === "1";
const SHOT_WIDTHS = (process.env.RESPONSIVE_SHOT_WIDTHS ?? "320,375,768,1024,1280").split(",").map(Number);
/** Freezes the browser's clock too when the server runs frozen, so countdowns in the captures hold still. */
const FROZEN = process.env.FREEZE_CLOCK_AT ? new Date(process.env.FREEZE_CLOCK_AT) : null;

/** A client address of its own for each test, so a production server's limit on new demos per client stays out of this. */
test.beforeEach(async ({ context, page }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.${octet()}.${octet()}.${octet()}` });
  if (FROZEN) await page.clock.setFixedTime(FROZEN);
});

let shared: pg.Pool | null = null;
/** The worker's pool, made again after afterAll ended it: with fullyParallel, afterAll runs after each test. */
const pool = (): pg.Pool =>
  (shared ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev",
    max: 3,
  }));

test.afterAll(async () => {
  const ending = shared;
  shared = null;
  await ending?.end();
});

// --- Pages and demos --------------------------------------------------------------------------------

/** The stream keeps event pages from ever going network-idle, so wait for React itself. */
async function untilHydrated(locator: Locator): Promise<void> {
  await expect(locator.first()).toBeVisible();
  await expect
    .poll(() => locator.first().evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
}

async function open(page: Page, url: string, ready: (page: Page) => Locator): Promise<void> {
  await page.goto(url);
  await untilHydrated(ready(page));
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

const main = (page: Page) => page.getByRole("main");
const bidCard = (page: Page) => page.getByRole("region", { name: "Place a bid" });
const holdButton = (page: Page) => main(page).getByRole("button").last();

async function startDemo(page: Page): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  const started = await page.request.post("/api/demo", { data: { firstName: "Sam" } });
  await page.goto(((await started.json()) as { href: string }).href);
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname;
}

const slugOf = (catalog: string) => catalog.split("/").at(-1) ?? "";

async function gala(catalog: string): Promise<{ eventId: string; paddleId: string }> {
  const { rows } = await pool().query<{ event_id: string; id: string }>(
    `select p.event_id, p.id from paddles p join events e on e.id = p.event_id where e.slug = $1 and p.first_name = 'Sam'`,
    [slugOf(catalog)],
  );
  const row = rows[0];
  if (!row) throw new Error("No paddle for Sam");
  return { eventId: row.event_id, paddleId: row.id };
}

/** The hold the PayPal return page would have authorized, on the paddle's live channel. */
async function hold(catalog: string, amountCents: number): Promise<void> {
  const { eventId, paddleId } = await gala(catalog);
  const client = await pool().connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       values ($1, $2, 'simulated', $3, 'authorized', now()) returning id`,
      [eventId, paddleId, amountCents],
    );
    await appendEventLog(client, [
      { eventId, paddleId, type: "hold", payload: { holdId: rows[0]?.id ?? "", status: "authorized", amountCents } },
    ]);
    await client.query("commit");
  } finally {
    client.release();
  }
}

/** Keeps a route waiting until `release` is called, then lets it through or fails it. */
async function stall(target: Page | BrowserContext, pattern: string): Promise<(outcome: "continue" | "abort") => void> {
  let release: (outcome: "continue" | "abort") => void = () => {};
  const released = new Promise<"continue" | "abort">((resolve) => {
    release = resolve;
  });
  await target.route(pattern, async (route: Route) => {
    const outcome = await released;
    await (outcome === "abort" ? route.abort() : route.continue()).catch(() => {});
  });
  return release;
}

// --- Checks -----------------------------------------------------------------------------------------

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.evaluate(() => document.fonts.ready);
}

/** Each target is at least `minimum` by `minimum` px: the state's primary actions take 44, the rest 40. */
async function expectTappable(targets: Array<[Locator, number]>, label: string): Promise<void> {
  for (const [target, minimum] of targets) {
    const count = await target.count();
    expect(count, `${label}: ${target.toString()} is on the page`).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const element = target.nth(index);
      const box = await element.boundingBox();
      const name = (await element.innerText().catch(() => "")) || ((await element.getAttribute("aria-label")) ?? "");
      expect(box, `${label}: "${name}" has a box`).not.toBeNull();
      expect(Math.round(box?.height ?? 0), `${label}: "${name.trim()}" height`).toBeGreaterThanOrEqual(minimum);
      expect(Math.round(box?.width ?? 0), `${label}: "${name.trim()}" width`).toBeGreaterThanOrEqual(minimum);
    }
  }
}

async function shoot(page: Page, name: string, width: number): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true });
}

type Targets = (page: Page) => Array<[Locator, number]>;

/** Every width in WIDTHS: no sideways overflow, no clipped text, and at 375 the targets a thumb needs. */
async function sweep(page: Page, name: string, targets: Targets = () => []): Promise<void> {
  for (const width of WIDTHS) {
    if (SHOTS_ONLY && !SHOT_WIDTHS.includes(width)) continue;
    await atWidth(page, width as Width);
    await settle(page);
    if (!SHOTS_ONLY) {
      const label = `${name} at ${width}`;
      await expectNoHorizontalOverflow(page, label);
      await expectNoClippedText(page, label);
      if (width === 375) await expectTappable(targets(page), label);
    }
    if (SHOT_WIDTHS.includes(width)) await shoot(page, name, width);
  }
  if (SHOTS && SHOT_WIDTHS.includes(1440)) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settle(page);
    await shoot(page, name, 1440);
  }
}

// --- 08 ---------------------------------------------------------------------------------------------

const tabs = (page: Page) => page.getByRole("navigation", { name: "Categories" }).getByRole("link");

test("08 with bidding power and bids: band, tabs, total and grid at every width", async ({ page }) => {
  await open(page, `${FIXTURE}${JAMIE}`, (p) => p.getByRole("button", { name: "Show 16 more lots" }));
  await sweep(page, "08-jamie", (p) => [
    [p.getByRole("button", { name: "Let Glim bid for me" }), 44],
    [p.getByRole("link", { name: "Bid again" }), 40],
    [p.getByRole("button", { name: "Let Glim watch" }), 40],
    [p.getByRole("button", { name: "Show 16 more lots" }), 44],
    [tabs(p), 40],
  ]);

  await page.getByRole("button", { name: "Show 16 more lots" }).click();
  await expect(page.getByRole("article")).toHaveCount(24);
  await sweep(page, "08-jamie-all");
});

test("08 filtered to one category", async ({ page }) => {
  await open(page, `${FIXTURE}${JAMIE}&category=dining`, (p) => tabs(p));
  await expect(page.getByRole("article")).toHaveCount(5);
  await sweep(page, "08-dining", (p) => [[tabs(p), 40]]);
});

test("08 before bidding power is set: the not-set band", async ({ page }) => {
  const catalog = await startDemo(page);
  await open(page, catalog, (p) => p.getByRole("link", { name: "Set bidding power" }));
  await sweep(page, "08-notset", (p) => [[p.getByRole("link", { name: "Set bidding power" }), 44]]);
});

// --- 05 ---------------------------------------------------------------------------------------------

const presets = (page: Page) => bidCard(page).getByRole("radio");
const galleryButtons = (page: Page) => page.getByRole("button", { name: /Save to my lots|Share this lot/ });

test("05 winning, then Max… open, typed and too low", async ({ page }) => {
  await open(page, `${FIXTURE}/lots/07${JAMIE}`, (p) => bidCard(p).getByRole("button", { name: /Place bid/ }));
  await sweep(page, "05-winning", (p) => [
    [bidCard(p).getByRole("button", { name: /Place bid/ }), 44],
    [presets(p), 44],
    [galleryButtons(p), 40],
    [bidCard(p).getByRole("button", { name: "Let Glim bid on this lot" }), 44],
  ]);

  await bidCard(page).getByRole("radio", { name: "Max…" }).click();
  // The whole field is the target: its label holds the input and focuses it.
  await sweep(page, "05-max-empty", (p) => [[p.locator("label", { has: p.getByRole("textbox", { name: "Your max" }) }), 44]]);

  await page.getByRole("textbox", { name: "Your max" }).fill("500");
  await expect(bidCard(page).getByRole("button", { name: /Set max bid/ })).toBeEnabled();
  await sweep(page, "05-max", (p) => [[bidCard(p).getByRole("button", { name: /Set max bid/ }), 44]]);

  await page.getByRole("textbox", { name: "Your max" }).fill("1");
  await expect(bidCard(page).getByRole("alert")).toBeVisible();
  await sweep(page, "05-max-low");
});

test("05 outbid: Bid again", async ({ page }) => {
  await open(page, `${FIXTURE}/lots/21${JAMIE}`, (p) => bidCard(p).getByRole("button", { name: /Bid again/ }));
  await sweep(page, "05-outbid", (p) => [[bidCard(p).getByRole("button", { name: /Bid again/ }), 44]]);
});

test("05 over bidding power: the numbers and the raise", async ({ page }) => {
  await open(page, `${FIXTURE}/lots/01${JAMIE}`, (p) => bidCard(p).getByRole("link", { name: "Raise bidding power" }));
  await expect(bidCard(page).getByRole("status")).toContainText("needs");
  await sweep(page, "05-raise", (p) => [[bidCard(p).getByRole("link", { name: "Raise bidding power" }), 44]]);
});

test("05 with no bids yet", async ({ page }) => {
  await open(page, `${FIXTURE}/lots/22${JAMIE}`, (p) => bidCard(p).getByRole("button", { name: /Place bid/ }));
  await expect(bidCard(page)).toContainText("Starting bid");
  await sweep(page, "05-nobids", (p) => [[bidCard(p).getByRole("button", { name: /Place bid/ }), 44]]);
});

test("05 while a bid is on its way (the spinner), then the refusal when it fails", async ({ page }) => {
  await open(page, `${FIXTURE}/lots/07${JAMIE}`, (p) => bidCard(p).getByRole("button", { name: /Place bid/ }));
  // The bid never reaches the server, so the fixture stays as seeded.
  const release = await stall(page, "**/api/events/*/lots/*/bid");
  await bidCard(page).getByRole("radio").nth(2).click();
  await bidCard(page).getByRole("button", { name: /Place bid/ }).click();
  await expect(bidCard(page).locator("button[aria-busy=true] svg")).toBeVisible();
  await sweep(page, "05-spinner");

  release("abort");
  await expect(bidCard(page).getByRole("alert")).toBeVisible();
  await sweep(page, "05-refusal");
});

test("05 before bidding power is set", async ({ page }) => {
  const catalog = await startDemo(page);
  await open(page, `${catalog}/lots/07`, (p) => bidCard(p).getByRole("link", { name: "Set bidding power" }));
  await sweep(page, "05-setpower", (p) => [[bidCard(p).getByRole("link", { name: "Set bidding power" }), 44]]);
});

test("05 before bidding opens", async ({ page }) => {
  const catalog = await startDemo(page);
  await pool().query(`update events set status = 'scheduled' where slug = $1`, [slugOf(catalog)]);
  await open(page, `${catalog}/lots/07`, (p) => bidCard(p));
  await expect(bidCard(page)).toContainText("Bidding opens");
  await sweep(page, "05-opens-soon");
});

test("05 won, sold and unsold, 08 closed, and 09 once bidding has closed", async ({ page }) => {
  const catalog = await startDemo(page);
  await hold(catalog, 300_000);
  await open(page, `${catalog}/lots/07`, (p) => bidCard(p).getByRole("button", { name: /Place bid/ }));
  await bidCard(page).getByRole("button", { name: /Place bid/ }).click();
  await expect(bidCard(page)).toContainText("You’re winning");

  const { eventId } = await gala(catalog);
  const { rows } = await pool().query<{ number: number; bid_count: number; mine: boolean }>(
    `select l.number, l.bid_count, coalesce(p.first_name = 'Sam', false) as mine
     from lots l left join paddles p on p.id = l.high_paddle_id where l.event_id = $1 order by l.number`,
    [eventId],
  );
  await closeEvent(eventId, { pool: pool() });
  await expect(bidCard(page)).toContainText("Final bid");
  await sweep(page, "05-won");

  const lotPath = (number: number) => `${catalog}/lots/${String(number).padStart(2, "0")}`;
  const sold = rows.find((lot) => lot.bid_count > 0 && !lot.mine);
  if (sold) {
    await open(page, lotPath(sold.number), (p) => bidCard(p));
    await expect(bidCard(page)).toContainText("You didn’t win this lot");
    await sweep(page, "05-sold");
  }
  const unsold = rows.find((lot) => lot.bid_count === 0);
  if (unsold) {
    await open(page, lotPath(unsold.number), (p) => bidCard(p));
    await expect(bidCard(page)).toContainText("This lot closed with no bids");
    await sweep(page, "05-unsold");
  }

  await open(page, catalog, (p) => p.getByRole("button", { name: /Show \d+ more/ }));
  await page.getByRole("button", { name: /Show \d+ more/ }).click();
  await sweep(page, "08-closed", (p) => [[p.getByRole("link", { name: "See your receipt" }), 44]]);

  await open(page, `${catalog}/power`, (p) => p.getByRole("link", { name: "Back to the lots" }));
  await expect(page.getByRole("heading", { name: "Bidding has closed" })).toBeVisible();
  await sweep(page, "09-closed", (p) => [[p.getByRole("link", { name: "Back to the lots" }), 44]]);
});

// --- 09 ---------------------------------------------------------------------------------------------

const amounts = (page: Page) => main(page).getByRole("radio");

test("09 set for the first time, then Other… empty, in range and out of range (frames 7 and 8)", async ({ page }) => {
  const catalog = await startDemo(page);
  await open(page, `${catalog}/power`, (p) => holdButton(p));
  await expect(page.getByRole("heading", { name: "Set your bidding power" })).toBeVisible();
  await sweep(page, "09-set", (p) => [
    [holdButton(p), 44],
    [amounts(p), 44],
  ]);

  await page.getByRole("radio", { name: "Other…" }).click();
  await sweep(page, "09-other-empty", (p) => [[p.getByRole("textbox"), 44]]);
  await page.getByRole("textbox").fill("750");
  await sweep(page, "09-other", (p) => [[holdButton(p), 44]]);
  await page.getByRole("textbox").fill("12");
  await expect(main(page).getByRole("alert")).toBeVisible();
  await sweep(page, "09-other-low");
});

test("09 while PayPal's window is open (frame 9)", async ({ page, context }) => {
  const catalog = await startDemo(page);
  await open(page, `${catalog}/power`, (p) => holdButton(p));
  // The window waits on PayPal's page; nothing is ever approved.
  const release = await stall(context, "**/paypal/return?**");
  const popupOpened = page.waitForEvent("popup");
  await holdButton(page).click();
  await popupOpened;
  await expect(main(page).getByRole("link", { name: "Continue in this tab" })).toBeVisible();
  await page.bringToFront();
  await sweep(page, "09-waiting", (p) => [[holdButton(p), 44]]);
  release("abort");
});

test("09 after a cancel on PayPal (frame 10)", async ({ page, context }) => {
  const catalog = await startDemo(page);
  await context.route("**/paypal/return?**", (route) =>
    route.fulfill({ status: 302, headers: { location: route.request().url().replace("/paypal/return", "/paypal/cancel") } }),
  );
  await open(page, `${catalog}/power`, (p) => holdButton(p));
  const popupOpened = page.waitForEvent("popup");
  await holdButton(page).click();
  // design/17 frame 4: the window stays to say so, until the guest closes it.
  const popup = await popupOpened;
  await popup.getByRole("button", { name: "Close window" }).click();
  if (!popup.isClosed()) await popup.waitForEvent("close");
  await expect(main(page).getByRole("status")).toContainText("Nothing was held.");
  await sweep(page, "09-canceled", (p) => [[holdButton(p), 44]]);
});

test("09 when PayPal could not start the hold (frame 11)", async ({ page }) => {
  const catalog = await startDemo(page);
  await open(page, `${catalog}/power`, (p) => holdButton(p));
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
  await holdButton(page).click();
  const popup = await popupOpened;
  if (!popup.isClosed()) await popup.waitForEvent("close");
  await expect(main(page).getByRole("status")).toContainText("Nothing was held.");
  await sweep(page, "09-failed", (p) => [[holdButton(p), 44]]);
});

test("09 when the browser blocks the window (design/17 frame 5)", async ({ page }) => {
  const catalog = await startDemo(page);
  await page.addInitScript(() => {
    window.open = () => null;
  });
  await open(page, `${catalog}/power`, (p) => holdButton(p));
  await holdButton(page).click();
  await expect(holdButton(page)).toHaveText("Continue to PayPal in this tab");
  await sweep(page, "09-blocked", (p) => [[holdButton(p), 44]]);
});

test("09 raise mode, and Other… in it (frame 12)", async ({ page }) => {
  // A demo of its own: the fixture's bidding power page reads the close by the database clock.
  const catalog = await startDemo(page);
  await hold(catalog, 50_000);
  await open(page, `${catalog}/power`, (p) => holdButton(p));
  await expect(page.getByRole("heading", { name: "Raise your bidding power" })).toBeVisible();
  await sweep(page, "09-raise", (p) => [
    [holdButton(p), 44],
    [amounts(p), 44],
  ]);
  await page.getByRole("radio", { name: "Other…" }).click();
  await page.getByRole("textbox").fill("400");
  await expect(main(page).getByRole("alert")).toBeVisible();
  await sweep(page, "09-raise-other");
});

test("09 at the top of what can be held", async ({ page }) => {
  const catalog = await startDemo(page);
  const { eventId } = await gala(catalog);
  const { rows } = await pool().query<{ max: number | null }>(`select hold_max_cents as max from events where id = $1`, [eventId]);
  await hold(catalog, highestHoldCents(resolveHoldLimits({ presetsCents: null, minCents: null, maxCents: rows[0]?.max ?? null })));
  await open(page, `${catalog}/power`, (p) => p.getByRole("link", { name: "Back to the lots" }));
  await expect(page.getByRole("heading", { name: "Your bidding power is at the top" })).toBeVisible();
  await sweep(page, "09-top", (p) => [[p.getByRole("link", { name: "Back to the lots" }), 44]]);
});
