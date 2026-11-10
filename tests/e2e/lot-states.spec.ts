import { expect as baseExpect, test, type Page } from "@playwright/test";
import pg from "pg";

import { closeEvent } from "@/server/engine";
import { appendEventLog } from "@/server/sse/notify";

/**
 * design/19 and design/20 on a real demo gala: 05's card before bidding opens and after it closes,
 * and 08's closed tiles. Run against a server with no frozen clock; every test starts its own demo.
 *
 *   DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/lot-states.spec.ts
 */
test.use({ channel: "chrome", viewport: { width: 1440, height: 900 } });

const expect = baseExpect.configure({ timeout: 20_000 });

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

async function startDemo(page: Page): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  // design/16 starts a demo with no name field; the API still takes one, so this spec's creator keeps its name.
  const started = await page.request.post("/api/demo", { data: { firstName: "Sam" } });
  await page.goto(((await started.json()) as { href: string }).href);
  await page.waitForURL(/\/e\/gala-[0-9a-z]{16}$/);
  return new URL(page.url()).pathname;
}

const slugOf = (catalog: string) => catalog.split("/").at(-1) ?? "";

async function gala(catalog: string): Promise<{ eventId: string; paddleId: string; paddleNumber: number }> {
  const { rows } = await pool().query<{ event_id: string; id: string; number: number }>(
    `select p.event_id, p.id, p.number from paddles p join events e on e.id = p.event_id where e.slug = $1 and p.first_name = 'Sam'`,
    [slugOf(catalog)],
  );
  const row = rows[0];
  if (!row) throw new Error("No paddle for Sam");
  return { eventId: row.event_id, paddleId: row.id, paddleNumber: row.number };
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

const bidCard = (page: Page) => page.getByRole("region", { name: "Place a bid" });
const pad = (value: number) => String(value).padStart(3, "0");

test("05 before bidding opens: the starting bid and when it opens, nothing to press (state 7)", async ({ page }) => {
  const catalog = await startDemo(page);
  await pool().query(`update events set status = 'scheduled' where slug = $1`, [slugOf(catalog)]);

  await page.goto(`${catalog}/lots/07`);
  const card = bidCard(page);
  await expect(card).toContainText("Bidding opens");
  await expect(card).toContainText(/Opens in \d/);
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(card.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("link")).toHaveCount(0);
  await expect(card).toContainText("Bids are held with PayPal. You’re only charged if you win.");
});

test("05 and 08 after the close: won, sold to another paddle, and no bids (states 8 and 9, tiles 4 to 6)", async ({ page }) => {
  const catalog = await startDemo(page);
  await hold(catalog, 300_000);
  await page.goto(`${catalog}/lots/07`);
  await bidCard(page).getByRole("button", { name: /Place bid/ }).click();
  await expect(bidCard(page)).toContainText("You’re winning");

  const { eventId, paddleNumber } = await gala(catalog);
  const { rows } = await pool().query<{ number: number; bid_count: number; winner: number | null }>(
    `select l.number, l.bid_count, p.number as winner
     from lots l left join paddles p on p.id = l.high_paddle_id
     where l.event_id = $1 order by l.number`,
    [eventId],
  );
  await closeEvent(eventId, { pool: pool() });

  // Won: the final bid, Sam's paddle, and when the payment comes.
  const card = bidCard(page);
  await expect(card).toContainText("Final bid");
  await expect(card).toContainText(/Won at \d+:\d\d [AP]M/);
  await expect(card).toContainText(`Paddle ${pad(paddleNumber)}You`);
  await expect(card).toContainText("You’ll pay with PayPal shortly");
  await expect(card).toContainText("The rest of your hold is released at the same time.");
  await expect(card.getByRole("radio")).toHaveCount(0);

  // Sold to another paddle.
  const sold = rows.find((lot) => lot.number !== 7 && lot.winner !== null && lot.winner !== paddleNumber);
  if (!sold?.winner) throw new Error("the demo has no lot another paddle leads");
  await page.goto(`${catalog}/lots/${String(sold.number).padStart(2, "0")}`);
  await expect(bidCard(page)).toContainText(`Sold to Paddle ${pad(sold.winner)}`);
  await expect(bidCard(page)).toContainText("You didn’t win this lot");
  await expect(bidCard(page)).toContainText("No charge");
  await expect(bidCard(page)).toContainText("You’re only charged for lots you win.");

  // 08: the tiles say how each lot ended.
  await page.goto(catalog);
  await page.getByRole("button", { name: /Show \d+ more/ }).click();
  const tile = (number: number) => page.getByRole("article").filter({ hasText: `Lot ${String(number).padStart(2, "0")} ·` });
  await expect(tile(7)).toContainText(/Won at/);
  await expect(tile(7)).toContainText("You’ll pay shortly");
  await expect(tile(sold.number)).toContainText(/Closed at/);
  await expect(tile(sold.number)).toContainText(`Sold to Paddle ${pad(sold.winner)}`);
  const unsold = rows.find((lot) => lot.bid_count === 0);
  if (unsold) await expect(tile(unsold.number)).toContainText("No bids");
  // Nothing on 08 offers a bid once bidding closed, and the band doesn't ask for bidding power.
  await expect(page.getByRole("link", { name: "Bid again" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Bidding power not set" })).toHaveCount(0);
});
