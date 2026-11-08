import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { hashSessionToken, sessionCookieName } from "../../src/server/sessions/cookie";

/**
 * 07 beside its approved PNG: the panel over 05 at 1440x900, at a native 2x, with the state the mockup
 * draws. The mockup joins two moments on purpose (a card waiting for Start bidding, and the chips and
 * event card of a plan already running), so the test writes those rows itself. Run the server with
 * FREEZE_CLOCK_AT, GLIM_MODE=recorded and DATABASE_URL on a freshly seeded fixture.
 *
 * mockups/ stays out of git, so without it the test only captures. FIDELITY_DIR keeps the capture.
 */
const VIEWPORT = { width: 1440, height: 900 };
const WINDOW_FRAME_HEIGHT = 87;
const FROZEN_BROWSER_CLOCK = new Date(process.env.FREEZE_CLOCK_AT ?? "2026-11-09T04:58:00.000Z");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
const SESSION_SECRET = process.env.SESSION_SECRET ?? "dev-only-".repeat(4);
const SLUG = "riverside-shelter-gala";
const APPROVED = path.join(process.cwd(), "mockups", "07-web-agent-chat.png");

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

/** The moments 07 joins: a plan already running (its chips) and its event card. */
async function joinTheMoments(client: pg.Client, paddleId: string): Promise<void> {
  const plan = await client.query<{ id: string }>(
    "insert into glim_plans (paddle_id, status, budget_cents, proposal, confirmed_at) values ($1, 'active', 50000, '{}'::jsonb, now()) returning id",
    [paddleId],
  );
  await client.query(
    `insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status)
     select $1, l.id, case l.number when 7 then 1 else 2 end, case l.number when 7 then 38000 else 12000 end, 'watching'
     from lots l join paddles p on p.event_id = l.event_id where p.id = $2 and l.number in (7, 12)`,
    [plan.rows[0]?.id, paddleId],
  );
  await client.query("insert into chat_messages (paddle_id, role, text, card_type, card) values ($1, 'glim', '', 'event', $2::jsonb)", [
    paddleId,
    JSON.stringify({
      type: "event",
      actionId: null,
      at: FROZEN_BROWSER_CLOCK.toISOString(),
      eyebrow: "9:14 PM · CHEF’S TABLE",
      line: "Someone bid $360. I raised to $380, your limit for this lot.",
      chip: { kind: "winning", amountCents: 38_000 },
    }),
  ]);
}

test("the panel matches the approved 07", async ({ browser, baseURL }, testInfo) => {
  const origin = baseURL ?? "http://localhost:3000";
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const { paddleId, cookie } = await jamieSession(client);

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
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  const box = await panel.boundingBox();
  if (!box) throw new Error("no panel");
  expect(box).toEqual({ x: 1008, y: 84, width: 400, height: 704 });

  const directory = process.env.FIDELITY_DIR ?? testInfo.outputDir;
  mkdirSync(directory, { recursive: true });
  const capture = await page.screenshot({ path: path.join(directory, "ui-07-panel.png"), clip: box });
  await context.close();
  await clearChat(client, paddleId);
  await client.end();

  test.skip(!existsSync(APPROVED), "mockups/ is not in this checkout");
  // In the approved PNG the window starts at (80, 112) of a 1600x1080 canvas, at 2x.
  const crop = { x: (box.x + 80) * 2, y: (box.y + 112) * 2, width: box.width * 2, height: box.height * 2 };
  const scratch = await browser.newPage();
  const differing = await scratch.evaluate(
    async ({ approved, mine, crop }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const pixels = (image: HTMLImageElement, x: number, y: number) => {
        const canvas = document.createElement("canvas");
        canvas.width = crop.width;
        canvas.height = crop.height;
        const drawing = canvas.getContext("2d");
        if (!drawing) throw new Error("no canvas");
        drawing.drawImage(image, -x, -y);
        return drawing.getImageData(0, 0, crop.width, crop.height).data;
      };
      const a = pixels(await load(approved), crop.x, crop.y);
      const b = pixels(await load(mine), 0, 0);
      let count = 0;
      for (let i = 0; i < a.length; i += 4) {
        const difference = Math.max(Math.abs((a[i] ?? 0) - (b[i] ?? 0)), Math.abs((a[i + 1] ?? 0) - (b[i + 1] ?? 0)), Math.abs((a[i + 2] ?? 0) - (b[i + 2] ?? 0)));
        if (difference > 48) count += 1;
      }
      return count / (crop.width * crop.height);
    },
    {
      approved: `data:image/png;base64,${readFileSync(APPROVED).toString("base64")}`,
      mine: `data:image/png;base64,${capture.toString("base64")}`,
      crop,
    },
  );
  expect(differing).toBeLessThan(0.001);
});
