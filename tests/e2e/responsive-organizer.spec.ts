import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { atWidth, expectNoClippedText, expectNoHorizontalOverflow, expectTappableTargets, WIDTHS, type Width } from "./support/responsive";

/**
 * The organizer's pages below the approved 1440: 12's control room in each of its states and 28's
 * Insights, at every width in WIDTHS, with nothing past the edge, no text cut off, and a phone's
 * primary actions big enough for a thumb. At 1440 the fidelity specs hold both pages to their boards.
 *
 * Needs a server with simulated payments and no engine tick. The charging state and the failed and
 * waiting rows are set in the database (they pass too quickly to catch in simulated mode), so the
 * spec takes the server's DATABASE_URL; without it those states are skipped.
 * RESPONSIVE_SHOTS=<folder> saves a full-page screenshot of each state at 320, 375, 768, 1024 and 1280.
 *
 *   PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=false npx next dev -p 3456
 *   DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 \
 *     npx playwright test tests/e2e/responsive-organizer.spec.ts
 */
test.use({ channel: "chrome" });
// Seven widths a state on a dev server, which compiles each route the first time it is asked.
test.setTimeout(420_000);

test.beforeEach(async ({ context }) => {
  const octet = () => Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `198.${octet()}.${octet()}.${octet()}` });
});

const SHOTS = process.env.RESPONSIVE_SHOTS;
const SHOT_WIDTHS: readonly Width[] = [320, 375, 768, 1024, 1280];
const PHONE: Width = 375;
/** The grids load their code after the page; a dev server builds it on first ask. */
const GRID_LOADS = 20_000;

async function startDemo(page: Page): Promise<string> {
  await atWidth(page, 1280);
  await page.goto("/", { waitUntil: "networkidle" });
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

/** Lot 22 has no bids in the Riverside story, so this bid wins it. */
async function winGolfLesson(page: Page, slug: string): Promise<void> {
  const bid = await page.request.post(`/api/events/${slug}/lots/22/bid`, { data: { amountCents: 7_500 } });
  expect(bid.status()).toBe(200);
}

async function closeBidding(page: Page, slug: string): Promise<void> {
  const closed = await page.request.post(`/api/events/${slug}/demo/close-bidding`, { data: {} });
  expect(closed.status()).toBe(200);
}

/** Charges through the route the rail's button posts to, and waits for the queue to finish. */
async function chargeWinners(page: Page, slug: string): Promise<void> {
  await expect
    .poll(async () => (await page.request.post(`/api/events/${slug}/settlement`, { data: {} })).status(), { timeout: 30_000 })
    .toBeLessThan(300);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/events/${slug}/settlement`)).json()) as { phase: string }).phase, { timeout: 150_000 })
    .toBe("charged");
}

const rail = (page: Page) => page.getByRole("complementary").filter({ hasText: /Bidding (open|closed)/ });
/** Glim's corner: the page's last block, after main. */
const corner = (page: Page) => page.locator("main").locator("xpath=following-sibling::div[1]");

function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function expectTall(locator: Locator, label: string, minimum: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, `${label} is on the page`).not.toBeNull();
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(minimum);
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(minimum);
}

interface StateCheck {
  name: string;
  url: string;
  /** Waits until the state is on screen. */
  ready: (page: Page) => Promise<void>;
  /** The state's primary actions, checked at 375. */
  primary?: (page: Page) => Locator[];
  /** Anything else this state holds at a given width. */
  also?: (page: Page, width: Width) => Promise<void>;
}

/** A dev server reloads open pages when files change under it; a navigation that reload cuts short is made again. */
async function visit(page: Page, url: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url);
      return;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
}

async function atEveryWidth(page: Page, state: StateCheck): Promise<void> {
  for (const width of WIDTHS) {
    const label = `${state.name} at ${width}`;
    await atWidth(page, width);
    await visit(page, state.url);
    await state.ready(page);
    await page.evaluate(() => document.fonts.ready);
    // The grids measure their frames once they are drawn.
    await page.waitForTimeout(300);

    await expectNoHorizontalOverflow(page, label);
    await expectNoClippedText(page, label);
    if (width === PHONE) {
      await expectTappableTargets(page, label);
      for (const action of state.primary?.(page) ?? []) await expectTall(action, `${label}: ${await action.textContent()}`, 44);
    }
    await state.also?.(page, width);

    if (SHOTS && SHOT_WIDTHS.includes(width)) {
      mkdirSync(SHOTS, { recursive: true });
      await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
      await page.screenshot({ path: path.join(SHOTS, `${state.name}-${width}.png`), fullPage: true });
    }
  }
}

/** The rail's one action, full width on a phone, and Glim's corner never over it. */
async function railActionHolds(page: Page, width: Width): Promise<void> {
  const actions = rail(page).locator("button, a");
  if ((await actions.count()) === 0) return;
  const box = await actions.last().boundingBox();
  const orb = await corner(page).boundingBox();
  if (box && orb) expect(overlaps(box, orb), `Glim's corner covers the rail's action at ${width}`).toBe(false);
  if (box && width <= 430) {
    const railBox = await rail(page).boundingBox();
    // The rail's padding is 20 on a phone: the action runs from one side to the other.
    expect(box.width, `the rail's action is full width at ${width}`).toBeGreaterThanOrEqual((railBox?.width ?? 0) - 40 - 1);
  }
}

/**
 * The ledger scrolls sideways inside its own frame, its paddle column pinned, wherever its columns don't
 * fit. Below 1280 the rail stands above it, so from 768 up the full-width ledger fits every column.
 */
async function ledgerScrollsInside(page: Page, width: Width): Promise<void> {
  await railActionHolds(page, width);
  const pinned = page.locator(".ledger-grid .ag-root.ag-has-left-pinned-cols");
  if (width <= 430) await expect(pinned, `the paddle column is pinned at ${width}`).toHaveCount(1);
  else await expect(pinned, `the ledger fits without pinning at ${width}`).toHaveCount(0);
  const [railBox, ledgerBox] = [await rail(page).boundingBox(), await page.getByRole("region", { name: "Settlement ledger" }).boundingBox()];
  if (railBox && ledgerBox) {
    if (width < 1280) expect(railBox.y + railBox.height, `the rail stands above the ledger at ${width}`).toBeLessThanOrEqual(ledgerBox.y);
    else expect(railBox.x, `the rail stands beside the ledger at ${width}`).toBeGreaterThanOrEqual(ledgerBox.x + ledgerBox.width);
  }
}

const heading = (page: Page) => rail(page).getByRole("heading");

test("12 at every width: open, ready with its checks passed, charged, charging, and failed and waiting rows", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await winGolfLesson(page, slug);
  const url = `/e/${slug}/organizer`;

  await atEveryWidth(page, {
    name: "12-live",
    url,
    ready: async (p) => {
      await expect(heading(p)).toHaveText(/^Closes in \d+:\d{2}$/);
      await expect(p.locator(".ledger-grid .ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
    },
    primary: (p) => [rail(p).getByRole("button", { name: "Close bidding now" }), p.getByRole("button", { name: "Download CSV" })],
    also: ledgerScrollsInside,
  });

  await closeBidding(page, slug);
  await atEveryWidth(page, {
    name: "12-ready",
    url,
    ready: async (p) => {
      await expect(heading(p)).toHaveText("Ready to charge");
      await expect(rail(p)).toContainText("All passed", { timeout: 30_000 });
      await expect(p.locator(".ledger-grid .ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
    },
    primary: (p) => [rail(p).getByRole("button", { name: /^Charge \d+ winners?$/ }), p.getByRole("button", { name: "Download CSV" })],
    also: ledgerScrollsInside,
  });

  await chargeWinners(page, slug);
  await atEveryWidth(page, {
    name: "12-charged",
    url,
    ready: async (p) => {
      await expect(heading(p)).toHaveText(/\d+ winners? charged/);
      await expect(p.locator(".ledger-grid .ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
    },
    primary: (p) => [rail(p).getByRole("link", { name: "See your receipt" })],
    also: ledgerScrollsInside,
  });

  const databaseUrl = process.env.DATABASE_URL;
  test.skip(!databaseUrl, "Set DATABASE_URL to the server's database for the charging and failed states");
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const settlement = (
      await db.query<{ id: string }>("select s.id from settlements s join events e on e.id = s.event_id where e.slug = $1", [slug])
    ).rows[0];
    expect(settlement).toBeDefined();
    const id = settlement?.id ?? "";

    // Charging: the five largest winners still to go, the first of them under way, and Sam's real
    // PayPal charge under way too. Their next try is an hour off, so the queue the page's reads nudge
    // leaves them where they are.
    await db.query("update settlements set status = 'running', finished_at = null where id = $1", [id]);
    await db.query(
      `with picked as (
         select id, action, row_number() over (order by amount_cents desc, id) as n
         from settlement_items where settlement_id = $1 and action <> 'void'
       )
       update settlement_items i
       set status = (case when picked.n = 1 or picked.action = 'capture' then 'processing' else 'queued' end)::settlement_item_status,
           paypal_capture_id = null, completed_at = null, next_attempt_at = now() + interval '1 hour'
       from picked where i.id = picked.id and (picked.n <= 5 or picked.action = 'capture')`,
      [id],
    );
    await atEveryWidth(page, {
      name: "12-charging",
      url,
      ready: async (p) => {
        await expect(heading(p)).toHaveText(/^Charging \d+ of \d+$/);
        await expect(p.locator(".ledger-grid .ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
      },
      also: ledgerScrollsInside,
    });

    // Finished with errors: the largest winner failed, the next one waits on PayPal, and the rest of
    // those went through. Both rows are on the ledger's first page, which is sorted by the charge.
    await db.query("update settlements set status = 'done_with_errors', finished_at = now() where id = $1", [id]);
    await db.query(
      `with picked as (
         select id, action, row_number() over (order by amount_cents desc, id) as n
         from settlement_items where settlement_id = $1 and action <> 'void'
       )
       update settlement_items i
       set status = (case when picked.n = 1 then 'failed' when picked.n = 2 then 'pending' else 'succeeded' end)::settlement_item_status,
           error_code = case when picked.n = 1 then 'INSTRUMENT_DECLINED' when picked.n = 2 then 'PENDING' else null end,
           completed_at = case when picked.n > 2 then now() else null end, next_attempt_at = null
       from picked where i.id = picked.id and (picked.n <= 5 or picked.action = 'capture')`,
      [id],
    );
    await atEveryWidth(page, {
      name: "12-failed",
      url,
      ready: async (p) => {
        await expect(p.locator(".ledger-grid .ledger-retry").first()).toBeVisible();
        await expect(p.getByRole("button", { name: /^Ask again, paddle/ })).toBeVisible();
      },
      primary: (p) => [rail(p).locator("button").last()],
      also: async (p, width) => {
        await ledgerScrollsInside(p, width);
        if (width === PHONE) {
          for (const retry of await p.locator(".ledger-grid .ledger-retry").all()) {
            const box = await retry.boundingBox();
            expect(box?.height ?? 0, "a row's Retry on a phone").toBeGreaterThanOrEqual(40);
          }
        }
      },
    });
  } finally {
    await db.end();
  }
});

test("12 at every width: a failed check names the hold and keeps the charge off", async ({ page }) => {
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

  await atEveryWidth(page, {
    name: "12-checks-failed",
    url: `/e/${slug}/organizer`,
    ready: async (p) => {
      await expect(heading(p)).toHaveText("Can’t charge yet");
      await expect(rail(p)).toContainText("Paddle 142 · Sam. PayPal shows it as voided.");
      await expect(p.locator(".ledger-grid .ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
    },
    primary: (p) => [rail(p).getByRole("button", { name: "Check again" })],
    also: ledgerScrollsInside,
  });
});

test("28 at every width: live, ready and charged, the widgets reflowing and the lots scrolling inside", async ({ page }) => {
  const slug = await startDemo(page);
  await holdFiveHundred(page, slug);
  await winGolfLesson(page, slug);
  const url = `/e/${slug}/organizer/insights`;
  const widget = (p: Page, name: string) => p.getByRole("region", { name, exact: true });

  const insights = (name: string, sub: RegExp): StateCheck => ({
    name,
    url,
    ready: async (p) => {
      await expect(p.getByRole("heading", { name: "Tonight" })).toBeVisible();
      await expect(widget(p, "Hold utilization")).toContainText(sub);
      await expect(widget(p, "Top lots").locator(".ag-row").first()).toBeVisible({ timeout: GRID_LOADS });
    },
    primary: (p) => [p.getByRole("button", { name: "Download CSV" })],
    also: async (p, width) => {
      // 4 across, then 2 by 2 below 1280, then one column on a phone.
      const tops = await Promise.all(["Raised", "Lots sold", "Bids", "Winners"].map(async (name) => (await widget(p, name).boundingBox())?.y ?? 0));
      const rows = new Set(tops.map((top) => Math.round(top))).size;
      expect(rows, `the four figures' rows at ${width}`).toBe(width >= 1280 ? 1 : width >= 768 ? 2 : 4);
      // The chart is drawn at its widget's width, its labels at their own size.
      const chart = widget(p, "Raised through the evening").getByRole("img");
      const [chartBox, frameBox] = [await chart.boundingBox(), await widget(p, "Raised through the evening").boundingBox()];
      expect((chartBox?.width ?? 0) <= (frameBox?.width ?? 0), `the chart fits its widget at ${width}`).toBe(true);
      expect(await chart.getAttribute("viewBox")).toBe(`0 0 ${Math.round(chartBox?.width ?? 0)} 216`);
      const orb = await corner(p).boundingBox();
      const csv = await p.getByRole("button", { name: "Download CSV" }).boundingBox();
      if (orb && csv) expect(overlaps(orb, csv)).toBe(false);
      // Top lots takes the full width below 1280, and its columns fit from 768 up; on a phone Lot stays put.
      const pinned = widget(p, "Top lots").locator(".ag-root.ag-has-left-pinned-cols");
      await expect(pinned, `Top lots pinned at ${width}`).toHaveCount(width <= 430 ? 1 : 0);
    },
  });

  await atEveryWidth(page, insights("28-live", /held is bid now/));
  await closeBidding(page, slug);
  await atEveryWidth(page, insights("28-ready", /will be charged/));
  await chargeWinners(page, slug);
  await atEveryWidth(page, insights("28-charged", /was charged/));
});
