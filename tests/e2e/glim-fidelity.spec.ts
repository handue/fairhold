import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { hashSessionToken, sessionCookieName } from "../../src/server/sessions/cookie";

/**
 * 07 beside its approved boards, card by card: the panel over 05 at 1440x900, at a native 2x, in the
 * moment design/21b draws (Jamie's sentence, the plan card with its "ON MY OWN" block, and Glim's own
 * card after the rival's $400). Each part is compared with the same part of the board it comes from,
 * rendered from the board's HTML in the same browser: the header and the chips with the input from
 * design/22 #11 (B2: pause bars, no "+"), the plan card from design/21 #1, Glim's card from design/21
 * #5. The boards supersede mockups/07, whose "+" and status line B2 changed. The mockup joins moments
 * on purpose, so the test writes those rows itself. Run the server with FREEZE_CLOCK_AT, GLIM_MODE=
 * recorded and DATABASE_URL on a freshly seeded fixture. FIDELITY_DIR keeps the captures.
 */
const VIEWPORT = { width: 1440, height: 900 };
const WINDOW_FRAME_HEIGHT = 87;
const FROZEN_BROWSER_CLOCK = new Date(process.env.FREEZE_CLOCK_AT ?? "2026-11-09T04:58:00.000Z");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-only-".repeat(4);
const SLUG = "riverside-shelter-gala";
const BOARD = (name: string) => `file://${path.join(process.cwd(), "design", `${name}.html`)}`;

test.use({
  channel: "chrome",
  launchOptions: {
    args: ["--force-device-scale-factor=2", `--window-size=${VIEWPORT.width},${VIEWPORT.height + WINDOW_FRAME_HEIGHT}`, "--hide-scrollbars", "--disable-gpu"],
  },
});

/** The fixture again as seeded at 8:58 PM, for the other specs: Jamie has no chat and no plan yet. */
async function clearChat(client: pg.Client, paddleId: string): Promise<void> {
  await client.query("delete from glim_transcript where paddle_id = $1", [paddleId]);
  await client.query("delete from chat_messages where paddle_id = $1", [paddleId]);
  await client.query("delete from glim_actions where paddle_id = $1 and source_event_log_id is not null", [paddleId]);
  await client.query("delete from glim_plans where paddle_id = $1 and status in ('proposed', 'active') and proposal is not null", [paddleId]);
  await client.query("delete from sessions where paddle_id = $1", [paddleId]);
  await client.query("delete from favorites where paddle_id = $1 and lot_id in (select id from lots where number = 9)", [paddleId]);
}

/** Jamie's chat cleared, with a session for this browser; the card itself comes through the route. */
async function jamieSession(client: pg.Client): Promise<{ paddleId: string; cookie: { name: string; value: string } }> {
  const { rows } = await client.query<{ id: string; event_id: string }>(
    "select p.id, p.event_id from paddles p join events e on e.id = p.event_id where e.slug = $1 and p.number = 142",
    [SLUG],
  );
  const jamie = rows[0];
  if (!jamie) throw new Error("Seed the fixture first: npm run db:seed");
  await clearChat(client, jamie.id);
  const token = randomBytes(32).toString("base64url");
  await client.query("insert into sessions (token_hash, event_id, paddle_id) values ($1, $2, $3)", [hashSessionToken(token, SESSION_SECRET), jamie.event_id, jamie.id]);
  return { paddleId: jamie.id, cookie: { name: sessionCookieName(SLUG), value: token } };
}

/**
 * The moments 21b joins: a plan already running (its header and chips), the rival's two cards, and
 * Glim's own card, with design/21 #5's words, as the autopilot stores it.
 */
async function joinTheMoments(client: pg.Client, paddleId: string): Promise<void> {
  const lots = await client.query<{ id: string; number: number }>(
    "select l.id, l.number from lots l join paddles p on p.event_id = l.event_id where p.id = $1 and l.number in (7, 9, 12)",
    [paddleId],
  );
  const lot = (number: number) => {
    const found = lots.rows.find((row) => row.number === number);
    if (!found) throw new Error(`no Lot ${number}`);
    return found.id;
  };
  const mandate = {
    v: 1,
    budgetCents: 50_000,
    lots: [
      { lotId: lot(7), lotNumber: 7, role: "plan", source: "words", rank: 1, capCents: null },
      { lotId: lot(12), lotNumber: 12, role: "plan", source: "words", rank: 2, capCents: 12_000 },
      { lotId: lot(9), lotNumber: 9, role: "backup", source: "heart", rank: 4, capCents: null },
    ],
    excludedLotIds: [],
    guestWords: [],
    confirmedAt: FROZEN_BROWSER_CLOCK.toISOString(),
  };
  const plan = await client.query<{ id: string }>(
    "insert into glim_plans (paddle_id, status, budget_cents, proposal, confirmed_at, mandate) values ($1, 'active', 50000, '{}'::jsonb, now(), $2::jsonb) returning id",
    [paddleId, JSON.stringify(mandate)],
  );
  const planId = plan.rows[0]?.id;
  for (const [number, priority, maxCents] of [[12, 2, 12_000], [9, 3, 38_000]] as const) {
    await client.query("insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, $3, $4, 'watching')", [
      planId,
      lot(number),
      priority,
      maxCents,
    ]);
  }
  const card = (type: string, body: Record<string, unknown>) =>
    client.query("insert into chat_messages (paddle_id, role, text, card_type, card, plan_id) values ($1, 'glim', '', $2, $3::jsonb, $4)", [
      paddleId,
      type,
      JSON.stringify(body),
      planId,
    ]);
  const at = FROZEN_BROWSER_CLOCK.toISOString();
  await card("event", { type: "event", actionId: null, at, eyebrow: "9:14 PM · CHEF’S TABLE", line: "Someone bid $360. I raised to $380, your limit for this lot.", chip: { kind: "winning", amountCents: 38_000 } });
  await card("event", { type: "event", actionId: null, at, eyebrow: "9:15 PM · CHEF’S TABLE", line: "Someone bid $400, over your $380 limit.", chip: null });
  await card("action", {
    type: "autopilot",
    runId: "00000000-0000-4000-8000-0000000021b5",
    actionId: "00000000-0000-4000-8000-0000000021b6",
    at,
    eyebrow: "9:15 PM · CHEF’S TABLE → WINE TASTING",
    triggerLine: null,
    whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
    whyLine: "The dinner is past your budget now, so your money goes to the wine tasting you hearted.",
    whySource: "model",
    chip: { kind: "winning", amountCents: 22_000 },
    rulesLine: "Your rules: $500 in all · Spa Day up to $120",
    skip: { lotId: lot(9), label: "Skip Wine Tasting" },
  });
}

/**
 * The share of pixels further apart than 48 of 255 in any channel, at the best alignment within three
 * device pixels: an element can sit on a half pixel in one page and a whole one in the other. Captures
 * more than four device pixels apart in size count as entirely different.
 */
async function differingShare(page: Page, approved: Buffer, mine: Buffer): Promise<number> {
  return page.evaluate(
    async ({ approved, mine }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [a, b] = await Promise.all([load(approved), load(mine)]);
      if (Math.abs(a.width - b.width) > 4 || Math.abs(a.height - b.height) > 4) return Number.POSITIVE_INFINITY;
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("no canvas");
        drawing.drawImage(image, 0, 0);
        return drawing.getImageData(0, 0, image.width, image.height).data;
      };
      const [pa, pb] = [pixels(a), pixels(b)];
      const width = Math.min(a.width, b.width) - 6;
      const height = Math.min(a.height, b.height) - 6;
      let best = Number.POSITIVE_INFINITY;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          let count = 0;
          for (let y = 3; y < 3 + height; y++) {
            for (let x = 3; x < 3 + width; x++) {
              const i = (y * a.width + x) * 4;
              const j = ((y + dy) * b.width + (x + dx)) * 4;
              const difference = Math.max(Math.abs((pa[i] ?? 0) - (pb[j] ?? 0)), Math.abs((pa[i + 1] ?? 0) - (pb[j + 1] ?? 0)), Math.abs((pa[i + 2] ?? 0) - (pb[j + 2] ?? 0)));
              if (difference > 48) count += 1;
            }
          }
          best = Math.min(best, count / (width * height));
        }
      }
      return best;
    },
    { approved: `data:image/png;base64,${approved.toString("base64")}`, mine: `data:image/png;base64,${mine.toString("base64")}` },
  );
}

/** The bottom of a panel, from its chips to its lower edge. */
async function bottomOf(page: Page, panel: Locator, chip: Locator): Promise<Buffer> {
  await panel.scrollIntoViewIfNeeded();
  const [box, top] = await Promise.all([panel.boundingBox(), chip.boundingBox()]);
  if (!box || !top) throw new Error("nothing to capture");
  return page.screenshot({ clip: { x: box.x, y: top.y, width: box.width, height: box.y + box.height - top.y } });
}

test("the panel matches its approved boards, card by card", async ({ browser, baseURL }, testInfo) => {
  const origin = baseURL ?? "http://localhost:3000";
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const { paddleId, cookie } = await jamieSession(client);
  await client.query("insert into favorites (paddle_id, lot_id) select $1, l.id from lots l join paddles p on p.event_id = l.event_id where p.id = $1 and l.number = 9 on conflict do nothing", [paddleId]);

  const context = await browser.newContext({ viewport: null, deviceScaleFactor: undefined, baseURL: origin });
  await context.addCookies([{ ...cookie, url: origin }]);
  const page = await context.newPage();
  await page.clock.setFixedTime(FROZEN_BROWSER_CLOCK);

  const answer = await page.request.post(`/api/glim/${SLUG}/messages`, {
    data: { text: "$500. I really want the chef’s dinner. Spa only under $120." },
    headers: { origin },
  });
  expect(await answer.text()).toContain('"type":"done"');
  await joinTheMoments(client, paddleId);

  await page.goto(`/e/${SLUG}/lots/07`);
  // The dev server's floating indicator is not part of the page.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("button", { name: "Chat with Glim" }).click();
  const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
  await expect(panel.getByText("Skip the spa")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Skip Wine Tasting" })).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await panel.boundingBox()).toEqual({ x: 1008, y: 84, width: 400, height: 704 });

  const directory = process.env.FIDELITY_DIR ?? testInfo.outputDir;
  mkdirSync(directory, { recursive: true });
  const mine = {
    header: await panel.locator("header").screenshot(),
    plan: await panel.locator('[data-card="plan"]').screenshot(),
    autopilot: await panel.locator('[data-card="autopilot"]').screenshot(),
    bottom: await bottomOf(page, panel, panel.getByRole("link", { name: "Raise my budget" })),
  };
  await page.screenshot({ path: path.join(directory, "ui-07-panel.png"), clip: { x: 1008, y: 84, width: 400, height: 704 } });
  await context.close();
  await clearChat(client, paddleId);
  await client.end();

  // The same parts of the boards, from their HTML in the same browser.
  const board = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 2 });
  await board.goto(BOARD("21-glim-autopilot"));
  await board.evaluate(() => document.fonts.ready);
  test.skip(!(await board.evaluate(() => document.fonts.check("14px Geist"))), "the boards' Geist font did not load");
  const autopilotBoard = board.locator(".n400");
  const approved = {
    plan: await autopilotBoard.nth(0).locator(".plan").screenshot(),
    autopilot: await autopilotBoard.nth(4).locator(".evt").nth(1).screenshot(),
  } as Record<string, Buffer>;
  await board.goto(BOARD("22-glim-chat-states"));
  await board.evaluate(() => document.fonts.ready);
  const backOnDuty = board.locator(".n400").nth(10).locator(".slice");
  approved.header = await backOnDuty.locator(".head").screenshot();
  approved.bottom = await bottomOf(board, backOnDuty, backOnDuty.locator(".quick span").first());

  for (const part of ["header", "plan", "autopilot", "bottom"] as const) {
    writeFileSync(path.join(directory, `ui-07-${part}.png`), mine[part]);
    writeFileSync(path.join(directory, `ui-07-${part}-approved.png`), approved[part] as Buffer);
    const share = await differingShare(board, approved[part] as Buffer, mine[part]);
    // Text on a half pixel in one page and a whole one in the other antialiases differently, and the
    // app's Geist Mono draws "→" from a fallback font, so a card can differ by about 1.5% at best.
    expect.soft(share, `07's ${part} against its board`).toBeLessThan(0.02);
  }
  await board.close();
});
