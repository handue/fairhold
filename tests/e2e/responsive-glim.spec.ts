import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import { HEIGHT_FOR, WIDTHS, atWidth, expectNoClippedText, expectNoHorizontalOverflow, type Width } from "./support/responsive";

/**
 * Glim's surfaces below the approved 1440: the 07 panel in each of its states and the corner orb with
 * its bubble, at every width in WIDTHS. Below 768 the panel is a full-screen sheet with the header at
 * the top and the input at the bottom, and the orb is 56, 16px in. From 768 up the panel floats above
 * the orb as at 1440, never taller than the viewport or wider than it less 32px. At 1440 itself
 * glim-panel.spec and glim-fidelity.spec hold 07 to its boards.
 *
 * Run like glim-panel.spec: next dev, keyless (GLIM_MODE=recorded, PAYMENTS_MODE=simulated), no frozen
 * clock and no tick, DATABASE_URL pointing where the server reads. RESPONSIVE_SHOTS=<dir> keeps a
 * screenshot of every state at 320, 375, 768, 1024 and 1280.
 *
 * The page behind the panel and around the orb belongs to the other tracks, so the tap-target check
 * here covers Glim's own controls: support/responsive's expectTappableTargets also counts every button
 * in the page's <main>, which sits under the sheet on a phone.
 */
test.use({ channel: "chrome" });
test.setTimeout(240_000);

// `next dev` reloads an open page whenever a file in the tree changes, and with other work in the same
// tree that reloaded the page under test every second or so. The page still gets the socket's hello,
// which it waits for before it hydrates, but none of the rebuild messages after it.
test.beforeEach(async ({ context }) => {
  await context.routeWebSocket(/\/_next\/(?:webpack-)?hmr/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const type = /^\{"type":"([^"]+)"/.exec(String(message))?.[1];
      if (type === undefined || type === "turbopack-connected") socket.send(message);
    });
  });
});

// A dev server compiles each route on its first request, which can take many seconds.
const expect = baseExpect.configure({ timeout: 30_000 });

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
const GOLDEN_SENTENCE = "$500. I really want the chef’s dinner. Spa only under $120.";
const SHOTS = process.env.RESPONSIVE_SHOTS;
const SHOT_WIDTHS = new Set<Width>([320, 375, 768, 1024, 1280]);
const PHONE = 768;
const INVITATION = "Want me to bid for you?";
/** 11's bubble before the charge, for a guest who won lots. */
const RECEIPT_NOTE = "Almost there";

async function withDatabase<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/** A demo gala of this browser's own, through the API, as glim-panel.spec starts one. */
async function startDemo(page: Page): Promise<string> {
  const started = await page.request.post("/api/demo", { data: { firstName: "Jamie" } });
  expect(started.status()).toBe(201);
  const { href } = (await started.json()) as { href: string };
  return href;
}

const slugOf = (href: string) => href.split("/").at(-1) ?? "";

/** $500 held for paddle 142, as if approved in PayPal's window. */
async function holdFiveHundred(href: string): Promise<void> {
  await withDatabase((client) =>
    client.query(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       select e.id, p.id, 'simulated', 50000, 'authorized', now()
       from events e join paddles p on p.event_id = e.id and p.number = 142 where e.slug = $1`,
      [slugOf(href)],
    ),
  );
}

const panelOf = (page: Page) => page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });

/** The orb's click, again until the panel answers: before the page hydrates and the panel mounts, a click does nothing. */
async function openPanel(page: Page): Promise<Locator> {
  const panel = panelOf(page);
  await expect(async () => {
    if (!(await panel.isVisible())) await page.getByRole("button", { name: "Chat with Glim" }).click();
    await expect(panel).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return panel;
}

async function say(page: Page, text: string): Promise<void> {
  const panel = panelOf(page);
  await panel.getByLabel("Message Glim").fill(text);
  await panel.getByRole("button", { name: "Send" }).click();
}

/** A demo with $500 held and the golden plan running, on 08. */
async function runningPlan(page: Page): Promise<{ href: string; panel: Locator }> {
  const href = await startDemo(page);
  await holdFiveHundred(href);
  await page.goto(href);
  const panel = await openPanel(page);
  await say(page, GOLDEN_SENTENCE);
  await panel.getByRole("button", { name: "Start bidding" }).click();
  await expect(panel.getByText("On duty · $500 held with PayPal")).toBeVisible();
  return { href, panel };
}

/** Two layout passes, so a resize has settled before anything is measured. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

/** The page's own checks, the demo guide included: below 1024 it folds into a bar inside the gutters. */
async function expectPageFits(page: Page, label: string): Promise<void> {
  await expectNoHorizontalOverflow(page, label);
  await expectNoClippedText(page, label);
}

async function shot(page: Page, name: string, width: Width): Promise<void> {
  if (!SHOTS || !SHOT_WIDTHS.has(width)) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`) });
}

/** Glim's own buttons and links: at least `minimum` square, the tap target support/responsive asks for. */
async function expectTappable(scope: Locator, label: string, minimum = 40): Promise<void> {
  const small = await scope.evaluate((root, min) => {
    const found: string[] = [];
    const targets = [root, ...root.querySelectorAll<HTMLElement>("button, a[href], input")].filter((element) => element.matches("button, a[href], input"));
    for (const element of targets) {
      // A field is hit through its label when it has one (the editor's), and it is its height that counts.
      const field = element.tagName === "INPUT";
      const rect = (field ? (element.closest("label") ?? element) : element).getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const tooSmall = field ? rect.height < min : rect.width < min || rect.height < min;
      if (tooSmall) {
        found.push(`${element.tagName.toLowerCase()} "${((element as HTMLElement).innerText || element.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
    return found;
  }, minimum);
  expect(small, `${label} small tap targets`).toEqual([]);
}

/** The panel as a full-screen sheet on a phone, or a floating card that fits the viewport from 768 up. */
async function expectPanelFits(page: Page, panel: Locator, width: Width, label: string): Promise<void> {
  const height = HEIGHT_FOR[width];
  const box = await panel.boundingBox();
  if (!box) throw new Error(`${label}: no panel`);
  if (width < PHONE) {
    expect(box, `${label} sheet`).toEqual({ x: 0, y: 0, width, height });
    const header = await panel.locator("header").boundingBox();
    expect(header?.y, `${label} header at the top`).toBe(0);
  } else {
    expect(box.width, `${label} width`).toBeLessThanOrEqual(width - 32);
    expect(box.x, `${label} left edge`).toBeGreaterThanOrEqual(16);
    expect(box.y, `${label} top edge`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `${label} bottom edge`).toBeLessThanOrEqual(height);
  }
  // The input, or the line in its place once bidding closes, sits at the panel's bottom, in view.
  const bottom = panel.locator("form, div.h-52").last();
  const input = await bottom.boundingBox();
  if (!input) throw new Error(`${label}: no input`);
  expect(input.y + input.height, `${label} input in view`).toBeLessThanOrEqual(Math.min(height, box.y + box.height) - 11);
}

/** Every width in WIDTHS: the panel fits, nothing scrolls sideways or is cut off, and a phone can tap it. */
async function panelAtEveryWidth(page: Page, name: string, ready?: (panel: Locator) => Promise<void>): Promise<void> {
  const panel = panelOf(page);
  for (const width of WIDTHS) {
    const label = `${name} at ${width}`;
    await atWidth(page, width);
    await settle(page);
    await expect(panel).toBeVisible();
    if (ready) await ready(panel);
    // Unless the check scrolled the log itself, the newest line is still in view after the resize.
    else expect(await panel.getByRole("log").evaluate((log) => log.scrollHeight - log.scrollTop - log.clientHeight), `${label} log at its end`).toBeLessThan(2);
    await expectPanelFits(page, panel, width, label);
    await expectPageFits(page, label);
    if (width === 375) await expectTappable(panel, label);
    await shot(page, name, width);
  }
}

/**
 * The corner on a page with the panel closed: the orb's size and inset, and the bubble inside the gutters.
 * Where the corner closes the page instead (`pageEnd`: 05, 09 and 11 below 1440), the orb sits at the
 * right gutter under the content, with the page's last 24px (32 from 768) under it.
 */
async function cornerAtEveryWidth(
  page: Page,
  name: string,
  bubbleTitle: string | null,
  pageEnd: "desk" | null = null,
): Promise<void> {
  const orb = page.getByRole("button", { name: "Chat with Glim" });
  for (const width of WIDTHS) {
    const label = `${name} corner at ${width}`;
    const height = HEIGHT_FOR[width];
    await atWidth(page, width);
    await settle(page);
    const inPage = pageEnd === "desk";
    const box = await orb.boundingBox();
    if (!box) throw new Error(`${label}: no orb`);
    const [size, inset, lift] = width < PHONE ? [56, 16, 16] : [68, 32, 28];
    const bottom = inPage ? (width < PHONE ? 24 : 32) : lift;
    // In the page, the corner keeps to the content's 1344 column, so it lines up with the receipt's edge.
    const right = inPage ? (width + Math.min(width, 1344)) / 2 - inset : width - inset;
    if (inPage) {
      // Measured from the page's end (its last block, wherever the page is scrolled, and above the screen's
      // bottom when the page is shorter than the screen); in the flow it can fall between pixels.
      const end = await page.evaluate(() => Math.max(...[...document.body.children].map((child) => child.getBoundingClientRect().bottom)));
      const expected = { x: right - size, y: end - bottom - size, width: size, height: size };
      for (const key of ["x", "y", "width", "height"] as const) expect(box[key], `${label} orb ${key}`).toBeCloseTo(expected[key], 0);
    } else {
      const expected = { x: right - size, y: height - bottom - size, width: size, height: size };
      expect(box, `${label} orb`).toEqual(expected);
    }
    if ((bubbleTitle === INVITATION || bubbleTitle === RECEIPT_NOTE) && width < 1024) {
      // Below 1024 the invitation leaves the orb on its own: the page's own Glim row makes the offer.
      // 11's note too: the receipt card ends with the same words there.
      await expect(page.getByText(bubbleTitle, { exact: true }).filter({ visible: true }), `${label} bubble`).toHaveCount(
        bubbleTitle === RECEIPT_NOTE ? 1 : 0,
      );
      if (bubbleTitle === RECEIPT_NOTE) await expect(page.getByRole("note"), `${label} the receipt's note`).toContainText(bubbleTitle);
    } else if (bubbleTitle) {
      const bubble = page.getByText(bubbleTitle, { exact: true }).filter({ visible: true }).locator("..");
      await expect(bubble, label).toBeVisible();
      const card = await bubble.boundingBox();
      if (!card) throw new Error(`${label}: no bubble`);
      expect(card.x, `${label} bubble inside the left gutter`).toBeGreaterThanOrEqual(width < PHONE ? 16 : 32);
      expect(card.x + card.width, `${label} bubble beside the orb`).toBeLessThanOrEqual(box.x - 12 + 0.5);
      expect(card.y + card.height, `${label} bubble resting on the orb's baseline`).toBeCloseTo(box.y + box.height, 0);
      // 09's hint is only its question on a phone, so it is never taller than the orb.
      if (width < PHONE && bubbleTitle === "Not sure how much?") expect(card.height, `${label} bubble height`).toBeLessThanOrEqual(size);
    }
    await expectNoClippedText(page, label);
    if (width === 375) await expectTappable(orb, label, 44);
    await shot(page, name, width);
  }
  // And at 1440 the corner is the approved one: 68, 32 in and 28 up, the bubble's sentence beside it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await settle(page);
  expect(await orb.boundingBox(), `${name} corner at 1440`).toEqual({ x: 1340, y: 804, width: 68, height: 68 });
  if (bubbleTitle) {
    const title = page.getByText(bubbleTitle, { exact: true }).filter({ visible: true });
    const card = await title.locator("..").boundingBox();
    expect((card?.x ?? 0) + (card?.width ?? 0), `${name} bubble at 1440`).toBeCloseTo(1328, 0);
    await expect(title.locator("+ p"), `${name} bubble's sentence at 1440`).toBeVisible();
  }
}

test.describe("Glim below 1440", () => {
  test("the corner orb and its bubble on every guest page", async ({ page }) => {
    const href = await startDemo(page);
    await page.goto(href);
    await cornerAtEveryWidth(page, "corner-08-no-hold", "Want me to bid for you?");
    await page.goto(`${href}/power`);
    await cornerAtEveryWidth(page, "corner-09", "Not sure how much?", "desk");
    await holdFiveHundred(href);
    await page.goto(`${href}/lots/07`);
    await cornerAtEveryWidth(page, "corner-05", "Want me to bid for you?", "desk");
    await page.goto(`${href}/paddle`);
    await cornerAtEveryWidth(page, "corner-10", "Want me to bid for you?");
  });

  test("first open: the greeting and its three chips", async ({ page }) => {
    const href = await startDemo(page);
    await holdFiveHundred(href);
    await page.goto(href);
    const panel = await openPanel(page);
    await expect(panel.getByRole("button", { name: "All $500" })).toBeVisible();
    await panelAtEveryWidth(page, "panel-first-open");

    // A phone turned sideways is wider than 768 but short: the card runs from 16 above the bottom, over
    // the orb, and keeps room to read.
    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page);
    const box = await panel.boundingBox();
    expect(box).toMatchObject({ y: 16, height: 390 - 32, width: 400 });
    expect(await panel.getByRole("log").evaluate((log) => log.clientHeight)).toBeGreaterThan(150);
    await expectPageFits(page, "panel-first-open at 844x390");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "panel-first-open-844x390.png") });
  });

  test("no bidding power: the set-power card", async ({ page }) => {
    const href = await startDemo(page);
    await page.goto(href);
    const panel = await openPanel(page);
    await expect(panel.getByRole("link", { name: "Set bidding power" })).toBeVisible();
    await panelAtEveryWidth(page, "panel-no-power");
  });

  test("the plan card before Start bidding, with its On my own block", async ({ page }) => {
    const href = await startDemo(page);
    await holdFiveHundred(href);
    await page.goto(href);
    const panel = await openPanel(page);
    await say(page, GOLDEN_SENTENCE);
    await expect(panel.getByRole("button", { name: "Start bidding" })).toBeVisible();
    await panelAtEveryWidth(page, "panel-plan-proposed", async (shown) => {
      await shown.locator('[data-card="plan"]').scrollIntoViewIfNeeded();
    });
    // On a phone Start bidding is a full row less Edit, 44px tall.
    await atWidth(page, 375);
    await settle(page);
    const start = await panel.getByRole("button", { name: "Start bidding" }).boundingBox();
    expect(start?.height).toBe(44);
    expect(start?.width).toBeGreaterThan(200);
  });

  test("the plan running: its card, the event card and the chips, then paused with Resume", async ({ page }) => {
    const { panel } = await runningPlan(page);
    await expect(panel.getByText(/· PLAN STARTED$/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Skip the spa" })).toBeVisible();
    await panelAtEveryWidth(page, "panel-plan-started");

    // The chips scroll sideways in their own row on a phone, and the last one can be reached.
    await atWidth(page, 320);
    await settle(page);
    const chips = panel.getByRole("button", { name: "How am I doing?" }).locator("..");
    const row = await chips.evaluate((element) => ({ scrolls: getComputedStyle(element).overflowX, wraps: element.scrollHeight > element.clientHeight + 1 }));
    expect(row).toEqual({ scrolls: "auto", wraps: false });
    await panel.getByRole("button", { name: "How am I doing?" }).scrollIntoViewIfNeeded();
    await expect(panel.getByRole("button", { name: "How am I doing?" })).toBeInViewport();

    await atWidth(page, 1280);
    await panel.getByRole("button", { name: "Pause Glim" }).click();
    await expect(panel.getByText(/^Paused since \d+:\d\d [AP]M$/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    await panelAtEveryWidth(page, "panel-paused");
  });

  test("the editor with fields, and This plan needs $X", async ({ page }) => {
    const href = await startDemo(page);
    await holdFiveHundred(href);
    await page.goto(href);
    const panel = await openPanel(page);
    await say(page, GOLDEN_SENTENCE);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    const chef = panel.getByLabel("Chef’s Table Dinner maximum, in whole dollars");
    await chef.fill("420");
    await expect(panel.getByText(/^This plan needs \$540$/)).toBeVisible();
    await panelAtEveryWidth(page, "panel-editor-over", async (shown) => {
      await shown.getByRole("button", { name: "Done" }).scrollIntoViewIfNeeded();
    });
    // A phone: each field is its own row, full width under the lot and 44px tall, 16px type.
    await atWidth(page, 375);
    await settle(page);
    const field = await chef.locator("..").boundingBox();
    const card = await panel.getByText(/^This plan needs/).locator("../..").boundingBox();
    expect(field?.height).toBe(44);
    expect(field?.width).toBeGreaterThan(220);
    expect(await chef.evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
    expect(card).not.toBeNull();
  });

  test("Glim's own card with Skip, and the raise it prepared", async ({ page }) => {
    const { href } = await runningPlan(page);
    await withDatabase(async (client) => {
      const { rows } = await client.query<{ paddle_id: string; plan_id: string; lot7: string; lot9: string }>(
        `select p.id as paddle_id, g.id as plan_id,
           (select id from lots where event_id = e.id and number = 7) as lot7,
           (select id from lots where event_id = e.id and number = 9) as lot9
         from events e join paddles p on p.event_id = e.id and p.number = 142
         join glim_plans g on g.paddle_id = p.id and g.status = 'active'
         where e.slug = $1`,
        [slugOf(href)],
      );
      const row = rows[0];
      if (!row) throw new Error("no running plan");
      await client.query("insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, 3, 38000, 'watching')", [
        row.plan_id,
        row.lot9,
      ]);
      const at = new Date().toISOString();
      const message = (type: string, card: Record<string, unknown>) =>
        client.query("insert into chat_messages (paddle_id, role, text, card_type, card, plan_id) values ($1, 'glim', '', $2, $3::jsonb, $4)", [
          row.paddle_id,
          type,
          JSON.stringify(card),
          row.plan_id,
        ]);
      // design/21 #5's words, as the autopilot stores its card.
      await message("action", {
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
        skip: { lotId: row.lot9, label: "Skip Wine Tasting" },
      });
      // V3: an open offer, as apply.ts prepares one.
      const action = await client.query<{ id: string }>(
        `insert into glim_actions (paddle_id, plan_id, lot_id, kind, amount_cents, hold_cents_at_time, decision, message, chip, detail)
         values ($1, $2, $3, 'autopilot_raise_prepared', 60000, 50000, 'executed', '', 'none', $4::jsonb) returning id`,
        [row.paddle_id, row.plan_id, row.lot7, JSON.stringify({ pendingIntent: [{ lotNumber: 7, maxCents: 46_000 }] })],
      );
      await message("action", {
        type: "autopilot_raise",
        runId: "00000000-0000-4000-8000-0000000021b7",
        actionId: action.rows[0]?.id,
        at,
        eyebrow: "9:16 PM · CHEF’S TABLE",
        askLine: "Chef’s Table now needs more than your $500 bidding power. Approve $600 and I’ll keep bidding on it.",
        whyLine: "You named $600 for tonight, and this keeps your top lot in reach.",
        whySource: "template",
        approveLabel: "Approve $600 in PayPal",
        dismissLabel: "Not now",
        note: "This opens PayPal to approve a $600 hold, within the $600 you named. You pay only for the lots you win.",
        endedLabel: "This offer ended",
        amountCents: 60_000,
        currentHoldCents: 50_000,
        budgetCents: 60_000,
        lotId: row.lot7,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      });
    });
    await page.reload();
    const again = await openPanel(page);
    await expect(again.getByRole("button", { name: "Skip Wine Tasting" })).toBeVisible();
    await expect(again.getByRole("button", { name: "Approve $600 in PayPal" })).toBeVisible();
    await expect(again.getByRole("button", { name: "Not now" })).toBeVisible();
    await panelAtEveryWidth(page, "panel-autopilot-raise", async (shown) => {
      await shown.getByRole("button", { name: "Not now" }).scrollIntoViewIfNeeded();
    });
    // On a phone the raise card's two buttons stack, each the card's full width and 44px tall.
    await atWidth(page, 375);
    await settle(page);
    const approve = await again.getByRole("button", { name: "Approve $600 in PayPal" }).boundingBox();
    const notNow = await again.getByRole("button", { name: "Not now" }).boundingBox();
    expect(approve?.height).toBe(44);
    expect(notNow?.height).toBe(44);
    expect(notNow?.width).toBe(approve?.width);
    expect(notNow?.y).toBeGreaterThan((approve?.y ?? 0) + 40);
    // Skip, too.
    await again.getByRole("button", { name: "Skip Wine Tasting" }).scrollIntoViewIfNeeded();
    await panelAtEveryWidth(page, "panel-autopilot-skip", async (shown) => {
      await shown.locator('[data-card="autopilot"]').scrollIntoViewIfNeeded();
    });
  });

  test("a refusal's hold card, and an error line", async ({ page }) => {
    const href = await startDemo(page);
    await holdFiveHundred(href);
    await page.goto(href);
    const panel = await openPanel(page);
    await say(page, "Can you also get me the cabin?");
    await expect(panel.getByRole("link", { name: "Raise bidding power" })).toBeVisible();
    await page.route("**/api/glim/*/messages", (route) => route.abort());
    await say(page, "How am I doing?");
    await expect(panel.getByText("I can’t answer right now. You can still bid yourself.")).toBeVisible();
    await page.unroute("**/api/glim/*/messages");
    // The newest line stays in view as the log gets shorter or longer with the window.
    await panelAtEveryWidth(page, "panel-hold-and-error", async (shown) => {
      await expect(shown.getByText("I can’t answer right now. You can still bid yourself.")).toBeInViewport();
    });

    // The keyboard: where it resizes the page (Android), the sheet shrinks with it, the input above the
    // keys and the newest line still in view. Safari leaves the page alone and moves the visual
    // viewport, which the sheet follows the same way (GlimPanel's visualViewport listener).
    await atWidth(page, 375);
    await panel.getByLabel("Message Glim").focus();
    await page.setViewportSize({ width: 375, height: 480 });
    await settle(page);
    expect(await panel.boundingBox()).toEqual({ x: 0, y: 0, width: 375, height: 480 });
    const field = await panel.locator("form").boundingBox();
    expect((field?.y ?? 0) + (field?.height ?? 0)).toBe(480 - 12);
    await expect(panel.getByText("I can’t answer right now. You can still bid yourself.")).toBeInViewport();
    await expect(panel.getByRole("button", { name: "Close" })).toBeInViewport();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "panel-keyboard-375x480.png") });
  });

  test("after the close: the closing card and the closed input, and 11's bubble", async ({ page }) => {
    const { href } = await runningPlan(page);
    const origin = new URL(page.url()).origin;
    const closed = await page.request.post(`/api/events/${slugOf(href)}/demo/close-bidding`, { headers: { origin } });
    expect(closed.status()).toBe(200);
    await page.goto(href);
    const panel = await openPanel(page);
    await expect(panel.getByText("Bidding has closed", { exact: false }).first()).toBeVisible();
    await panelAtEveryWidth(page, "panel-closed");
    await panel.getByRole("button", { name: "Close" }).click();
    await page.goto(`${href}/receipt`);
    await cornerAtEveryWidth(page, "corner-11-pending", "Almost there", "desk");
  });
});
