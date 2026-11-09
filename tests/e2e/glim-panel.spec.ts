import { expect as baseExpect, test, type Page } from "@playwright/test";
import pg from "pg";

/**
 * 07 in a browser, on a demo gala with recorded replies: run the server keyless (GLIM_MODE=recorded)
 * with DATABASE_URL pointing where this test writes. The hold goes straight into the database, since
 * approving one is the holds track's window.
 */
test.use({ channel: "chrome" });
test.setTimeout(120_000);

// A dev server compiles each route on its first request, which can take many seconds.
const expect = baseExpect.configure({ timeout: 30_000 });

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
const GOLDEN_SENTENCE = "$500. I really want the chef’s dinner. Spa only under $120.";

async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A demo gala of this browser's own, through the API (tests/e2e/entry.spec.ts walks the home page). */
async function startDemo(page: Page, firstName = "Jamie"): Promise<string> {
  const started = await page.request.post("/api/demo", { data: { firstName } });
  expect(started.status()).toBe(201);
  const { href } = (await started.json()) as { href: string };
  await page.goto(href);
  return href;
}

/** $500 held for paddle 142, as if approved in PayPal's window. */
async function holdFiveHundred(path: string): Promise<void> {
  const slug = path.split("/").at(-1);
  await withDatabase((client) =>
    client.query(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       select e.id, p.id, 'simulated', 50000, 'authorized', now()
       from events e join paddles p on p.event_id = e.id and p.number = 142 where e.slug = $1`,
      [slug],
    ),
  );
}

const panelOf = (page: Page) => page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });

async function openPanel(page: Page) {
  await page.getByRole("button", { name: "Chat with Glim" }).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  return panel;
}

async function say(page: Page, text: string) {
  const panel = panelOf(page);
  await panel.getByLabel("Message Glim").fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
}

test("opens at 07's size above the orb, the bubble stepping aside, and closes again", async ({ page }) => {
  const path = await startDemo(page);
  await holdFiveHundred(path);
  await page.goto(path);
  await expect(page.getByText("Want me to bid for you?")).toBeVisible();

  const panel = await openPanel(page);
  await expect(panel).toHaveCSS("width", "400px");
  await expect(panel).toHaveCSS("height", "704px");
  const box = await panel.boundingBox();
  expect(box).toMatchObject({ x: 1440 - 32 - 400, y: 900 - 112 - 704 });
  await expect(panel.getByText("Hi Jamie. What’s your budget tonight?")).toBeVisible();
  // design/22 #1: not on duty until Start bidding, and the first open's three chips.
  await expect(panel.getByText("Not bidding yet · $500 held with PayPal")).toBeVisible();
  await expect(panel.getByRole("button", { name: "All $500" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "What closes next?" })).toBeVisible();
  await expect(page.getByText("Want me to bid for you?")).toBeHidden();

  await panel.getByRole("button", { name: "Minimize" }).click();
  await expect(panel).toBeHidden();
  await expect(page.getByText("Want me to bid for you?")).toBeVisible();

  await page.getByRole("button", { name: "Let Glim bid for me" }).click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();

  await openPanel(page);
  await page.getByRole("button", { name: "Chat with Glim" }).click();
  await expect(panel).toBeHidden();
});

test("the golden sentence shows the plan card, and Start bidding bids, all kept across a reload", async ({ page }) => {
  const path = await startDemo(page);
  await holdFiveHundred(path);
  await page.goto(path);
  const panel = await openPanel(page);

  await say(page, GOLDEN_SENTENCE);
  await expect(panel.getByText("My plan for you")).toBeVisible();
  await expect(panel.getByText("Chef’s Table Dinner")).toBeVisible();
  await expect(panel.getByText("Spa Day for Two")).toBeVisible();
  await expect(panel.getByText("$380")).toBeVisible();
  await expect(panel.getByText("$120").first()).toBeVisible();
  // V1 (design/21 #3): the rules Start bidding agrees to; no heart yet, so no backup.
  await expect(panel.getByText("On my own")).toBeVisible();
  await expect(panel.getByText("Never past $500 in all, and Spa Day up to $120.")).toBeVisible();

  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByRole("button", { name: "Start bidding" })).toHaveCount(0);
  await expect(panel.getByText(/^Started at /)).toBeVisible();
  await expect(panel.getByText("On duty · $500 held with PayPal")).toBeVisible();
  await expect(panel.getByText(/· PLAN STARTED$/)).toBeVisible();
  await expect(panel.getByText(/I bid \$\d+ for you\. I’ll go up to \$120\./)).toBeVisible();
  await expect(panel.getByText(/^Winning · \$\d+$/).first()).toBeVisible();
  await expect(panel.getByRole("button", { name: "Skip the spa" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Raise my budget" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "How am I doing?" })).toBeVisible();

  await page.reload();
  await expect(page.getByText("Want me to bid for you?")).toBeHidden();
  const again = await openPanel(page);
  await expect(again.getByText(GOLDEN_SENTENCE)).toBeVisible();
  await expect(again.getByText(/^Started at /)).toBeVisible();
});

test("Skip, Pause and Resume answer in the chat, Pause and Resume from the header", async ({ page }) => {
  const path = await startDemo(page);
  await holdFiveHundred(path);
  await page.goto(path);
  const panel = await openPanel(page);
  await say(page, GOLDEN_SENTENCE);
  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByRole("button", { name: "Pause Glim" })).toBeVisible();

  await panel.getByRole("button", { name: "Pause Glim" }).click();
  await expect(panel.getByText(/^Paused since \d+:\d\d [AP]M$/)).toBeVisible();
  await expect(panel.getByText("I won’t bid or change your plan until you resume. Your bids stand.")).toBeVisible();

  await panel.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(panel.getByText("On duty · $500 held with PayPal")).toBeVisible();
  await expect(panel.getByText(/^I’m back on duty\./)).toBeVisible();

  await panel.getByRole("button", { name: "Skip the spa" }).click();
  await expect(panel.getByText(/^I stopped bidding on Spa Day\. Your \$\d+ bid stands\.$/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Skip the spa" })).toHaveCount(0);
});

test("a rival's bid reaches the open panel as 07's event card, with no reload", async ({ page, browser }) => {
  const path = await startDemo(page);
  const slug = path.split("/").at(-1) ?? "";
  await holdFiveHundred(path);
  await page.goto(path);
  const panel = await openPanel(page);
  await say(page, GOLDEN_SENTENCE);
  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByText("I bid $320 for you. I’ll go up to $380.")).toBeVisible();

  // Another guest, in their own browser, with room to outbid Jamie.
  const context = await browser.newContext();
  const joined = await context.request.post(`/api/events/${slug}/join`, { data: { firstName: "Rival" } });
  const { paddleNumber } = (await joined.json()) as { paddleNumber: number };
  await withDatabase((client) =>
    client.query(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       select e.id, p.id, 'simulated', 100000, 'authorized', now()
       from events e join paddles p on p.event_id = e.id and p.number = $2 where e.slug = $1`,
      [slug, paddleNumber],
    ),
  );
  const bid = (amountCents: number) => context.request.post(`/api/events/${slug}/lots/7/bid`, { data: { amountCents } });

  expect((await bid(34_000)).status()).toBe(200);
  await expect(panel.getByText("Someone bid $340. I raised to $360.")).toBeVisible();
  await expect(panel.getByText("Winning · $360")).toBeVisible();

  expect((await bid(40_000)).status()).toBe(200);
  await expect(panel.getByText("Someone bid $400, over your $380 limit.")).toBeVisible();
  await context.close();
});

test("a refusal offers a raise, opening 09 with the amount and the way back", async ({ page }) => {
  const path = await startDemo(page);
  await holdFiveHundred(path);
  await page.goto(path);
  const panel = await openPanel(page);

  await say(page, "Can you also get me the cabin?");
  const offer = panel.getByRole("link", { name: "Raise bidding power" });
  await expect(offer).toBeVisible();
  // design/22 #5: the lot and what is left, and 20's note.
  await expect(panel.getByText("Cabin Stay · Current bid")).toBeVisible();
  await expect(panel.getByText("You’ll approve another hold in a PayPal window.")).toBeVisible();
  expect(await offer.getAttribute("href")).toBe(`${path}/power?amount=1000&next=${encodeURIComponent(path)}`);
});

test("Edit opens the card's maximums as fields, and Done waits until the plan fits", async ({ page }) => {
  const path = await startDemo(page);
  await holdFiveHundred(path);
  await page.goto(path);
  const panel = await openPanel(page);
  await say(page, GOLDEN_SENTENCE);
  // The + is gone with its lot picker (B2).
  await expect(panel.getByRole("button", { name: "Add a lot to my plan" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Edit", exact: true }).click();
  const chef = panel.getByLabel("Chef’s Table Dinner maximum, in whole dollars");
  await expect(chef).toHaveValue("380");
  await chef.fill("420");
  await expect(panel.getByText(/^This plan needs \$540$/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "Done" })).toBeDisabled();
  await chef.fill("360");
  await panel.getByLabel("Spa Day for Two maximum, in whole dollars").fill("140");
  await panel.getByRole("button", { name: "Done" }).click();
  await expect(panel.getByText("Replaced at", { exact: false })).toBeVisible();
  await expect(panel.getByText("Never past $500 in all, and Spa Day up to $140.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Start bidding" })).toBeVisible();
});

test("a guest with no bidding power is sent to set it", async ({ page }) => {
  await startDemo(page);
  const panel = await openPanel(page);
  await expect(panel.getByText("Bidding power not set")).toBeVisible();
  await expect(panel.getByText("Hi Jamie. Set your bidding power first. Then I can plan your bids.")).toBeVisible();
  // design/22 #2: 19's button and 20's note under the greeting.
  await expect(panel.getByRole("link", { name: "Set bidding power" })).toBeVisible();
  await expect(panel.getByText("It’s a hold with PayPal, not a charge.")).toBeVisible();
});

test("shows no panel on the projector or the organizer's pages", async ({ page }) => {
  const path = await startDemo(page);
  await page.goto(`${path}/projector`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("glim:open", { detail: {} })));
  await expect(panelOf(page)).toHaveCount(0);
  await page.goto(`${path}/organizer`);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("glim:open", { detail: {} })));
  await expect(panelOf(page)).toHaveCount(0);
});
