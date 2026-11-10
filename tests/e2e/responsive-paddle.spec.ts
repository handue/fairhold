import { mkdirSync } from "node:fs";
import path from "node:path";

import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";
import pg from "pg";

import {
  atWidth,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectTappableTargets,
  HEIGHT_FOR,
  WIDTHS,
  type Width,
} from "./support/responsive";

/**
 * 10 My paddle, 11 the receipt, 25b its print page and 14 the projector below the approved 1440, at
 * every width in WIDTHS: nothing scrolls sideways, no text is cut off, and the primary actions are
 * thumb-sized at 375. Run it twice, once per seeded moment; the tests for the other moment skip.
 *
 *   npm run db:seed -- --moment=paddle --date=2026-11-07
 *   FREEZE_CLOCK_AT=2026-11-08T05:15:40.000Z npx next dev -p 3504
 *   DATABASE_URL=<the server's> FREEZE_CLOCK_AT=2026-11-08T05:15:40.000Z PLAYWRIGHT_BASE_URL=http://localhost:3504 \
 *     npx playwright test tests/e2e/responsive-paddle.spec.ts
 *
 *   npm run db:seed -- --moment=closed --date=2026-11-07      # again before each run: the run charges
 *   FREEZE_CLOCK_AT=2026-11-08T05:30:00.000Z npx next dev -p 3504
 *   (the same command, with FREEZE_CLOCK_AT=2026-11-08T05:30:00.000Z)
 *
 * The paddle moment's states: 142 with Glim on duty, 92 with its plan paused, 119 with no bids yet,
 * 151 with bids and no plan, 109 with a raise waiting in a PayPal window, and 301 with no hold (sent to
 * 09). The closed moment's: 142 pending then paid, 119 releasing then released, 302 never held, 25b,
 * and 14 after the close. The spec writes those states into the seeded fixture itself (reseed to
 * undo them; the projector's before-opening state is put back at once), so it needs a database of its
 * own: other specs expect 92's plan running. RESPONSIVE_SHOTS=<dir> also saves full-page captures at
 * 320, 375, 768, 1024, 1280 and 1440 (RESPONSIVE_SHOTS_ONLY=1 for the captures alone,
 * RESPONSIVE_SHOT_WIDTHS=1440 for some widths).
 */
test.use({ channel: "chrome" });
// One worker, in order: the projector's before-opening state and the charge change the event for everyone.
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

const expect = baseExpect.configure({ timeout: 20_000 });

const GALA = "/e/riverside-shelter-gala";
const SLUG = "riverside-shelter-gala";
const FROZEN = process.env.FREEZE_CLOCK_AT ? new Date(process.env.FREEZE_CLOCK_AT) : null;
const SHOTS = process.env.RESPONSIVE_SHOTS ?? null;
/** RESPONSIVE_SHOT_WIDTHS=1440 (a comma list) captures only those widths. */
const SHOT_WIDTHS = (process.env.RESPONSIVE_SHOT_WIDTHS ?? "320,375,768,1024,1280,1440").split(",").map(Number);
/** RESPONSIVE_SHOTS_ONLY=1 skips the checks and only captures, for a before-and-after comparison. */
const CHECKS = !process.env.RESPONSIVE_SHOTS_ONLY;

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:54329/fairhold_dev";
let shared: pg.Pool | null = null;
const pool = (): pg.Pool => (shared ??= new pg.Pool({ connectionString: databaseUrl, max: 2 }));

test.afterAll(async () => {
  const ending = shared;
  shared = null;
  await ending?.end();
});

async function eventRow(): Promise<{ id: string; status: string; opensAt: Date }> {
  const { rows } = await pool().query<{ id: string; status: string; opens_at: Date }>(
    "select id, status::text as status, opens_at from events where slug = $1",
    [SLUG],
  );
  const row = rows[0];
  if (!row) throw new Error(`Seed ${SLUG} first`);
  return { id: row.id, status: row.status, opensAt: row.opens_at };
}

async function paddleId(eventId: string, number: number): Promise<string> {
  const { rows } = await pool().query<{ id: string }>("select id from paddles where event_id = $1 and number = $2", [eventId, number]);
  const id = rows[0]?.id;
  if (!id) throw new Error(`No paddle ${number}`);
  return id;
}

/** A guest who joined and never held bidding power. */
async function ensurePaddleWithoutHold(eventId: string, number: number, firstName: string): Promise<void> {
  await pool().query(
    `insert into paddles (event_id, number, first_name, last_initial)
     select $1, $2, $3, 'R' where not exists (select 1 from paddles where event_id = $1 and number = $2)`,
    [eventId, number, firstName],
  );
}

let moment: "paddle" | "closed" | null = null;

test.beforeEach(async ({ page }) => {
  // A dev server's hot reload can restart a page in the middle of a check, over and over while files
  // change. The page still needs its socket to hydrate, so only the restarts are held back.
  await page.routeWebSocket(/\/_next\/(webpack-)?hmr/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (!/"reloadPage"|"type":"restart"/.test(String(message))) socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
});

test.beforeAll(async () => {
  const event = await eventRow();
  moment = event.status === "live" ? "paddle" : "closed";
  if (moment === "paddle") {
    // 92's plan paused at 9:12 PM; 109's raise open in a PayPal window; 301 joined with no hold.
    const paused = await paddleId(event.id, 92);
    await pool().query(
      "update glim_plans set status = 'paused', paused_at = '2026-11-08T05:12:00Z' where paddle_id = $1 and status in ('active', 'paused')",
      [paused],
    );
    const raising = await paddleId(event.id, 109);
    await pool().query("delete from holds where paddle_id = $1 and status = 'pending_approval'", [raising]);
    await pool().query(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status) values ($1, $2, 'simulated', 25000, 'pending_approval')`,
      [event.id, raising],
    );
    await ensurePaddleWithoutHold(event.id, 301, "Robin");
  } else {
    await ensurePaddleWithoutHold(event.id, 302, "Robin");
  }
});

async function open(page: Page, url: string): Promise<void> {
  if (FROZEN) await page.clock.setFixedTime(FROZEN);
  // "load", not "networkidle": a page's stream stays open.
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  // Hydrated: the projector and 25b fit themselves to the screen from an effect.
  await page.waitForFunction(() =>
    [...document.querySelectorAll("body *")].some((element) => Object.keys(element).some((key) => key.startsWith("__reactFiber"))),
  );
}

/**
 * A dev server's rebuild (another file saved) can reload the page under a check. A reload in the middle
 * starts that width again; any other failure is the page's.
 */
async function retryOnReload(run: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (error) {
      const reloaded = /context was destroyed|interrupted by another navigation|frame was detached/.test(String(error));
      if (!reloaded || attempt >= 5) throw error;
    }
  }
}

async function shoot(page: Page, name: string, width: number): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.screenshot({ path: path.join(SHOTS, `${name}-${width}.png`), fullPage: true, animations: "disabled" });
}

interface PageState {
  name: string;
  url: string;
  /** What must be on the page, so a check never passes on a redirect or an error page. */
  ready: (page: Page) => Promise<void>;
  /** The primary actions a thumb has to hit at 375 (also outside <main>, which the shared check reads). */
  actions?: (page: Page) => ReturnType<Page["getByRole"]>[];
  /** What else must hold at a width (a scaled sheet or board that fits). */
  fits?: (page: Page, width: Width) => Promise<void>;
}

/** The element's box, once its fit has run, inside the screen: `bleed` is the room it leaves at each side. */
async function expectInside(page: Page, selector: string, width: number, height: number | null, bleed = 0): Promise<void> {
  await expect
    .poll(async () => {
      const box = await page.locator(selector).boundingBox();
      if (!box) return `${selector} missing`;
      const inside = box.x >= bleed - 1 && box.x + box.width <= width - bleed + 1 && (height === null || box.height <= height + 1);
      return inside ? "inside" : `${selector} at ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`;
    })
    .toBe("inside");
}

/** Every width in WIDTHS, then the captures. */
async function checkEveryWidth(page: Page, state: PageState): Promise<void> {
  for (const width of CHECKS ? WIDTHS : []) {
    await atWidth(page, width);
    await retryOnReload(async () => {
      await open(page, state.url);
      await state.ready(page);
      const label = `${state.name} at ${width}`;
      await expectNoHorizontalOverflow(page, label);
      await expectNoClippedText(page, label);
      await state.fits?.(page, width);
      if (width !== 375) return;
      await expectTappableTargets(page, label);
      for (const action of state.actions?.(page) ?? []) {
        const box = await action.boundingBox();
        expect(box, `${label}: ${action.toString()} is on the page`).not.toBeNull();
        expect(box!.height, `${label}: ${action.toString()} height`).toBeGreaterThanOrEqual(44);
        expect(box!.width, `${label}: ${action.toString()} width`).toBeGreaterThanOrEqual(44);
      }
    });
  }
  if (SHOTS) {
    for (const width of SHOT_WIDTHS) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : width <= 430 ? 812 : width === 768 ? 1024 : 800 });
      await retryOnReload(async () => {
        await open(page, state.url);
        await state.ready(page);
        await shoot(page, state.name, width);
      });
    }
  }
}

const region = (page: Page, name: string) => page.getByRole("region", { name });

/**
 * 14: a landscape screen from 1024 wide shows the whole 1440 x 900 board scaled into it; a phone or an
 * upright tablet gets the board flowed down the page, as wide as the screen.
 */
async function projectorFits(page: Page, width: Width): Promise<void> {
  const height = HEIGHT_FOR[width];
  const scaled = width >= 768 && width >= height;
  await expectInside(page, ".fh-projector", width, scaled ? height : null);
  if (scaled) {
    const box = await page.locator(".fh-projector").boundingBox();
    expect(Math.round(box!.width), "the board keeps its 16:10 shape").toBe(Math.round((box!.height * 1440) / 900));
  }
}

/**
 * On the page and seen. For the before captures, where an old layout can squeeze a column to nothing,
 * on the page and out of the streamed HTML's hidden holder.
 */
async function shown(locator: Locator): Promise<void> {
  if (CHECKS || (locator.page().viewportSize()?.width ?? 0) >= 1024) return expect(locator).toBeVisible();
  await expect(locator).toBeAttached();
  await expect(locator.locator("xpath=ancestor-or-self::*[@hidden]")).toHaveCount(0);
}

test.describe("the paddle moment, bidding open", () => {
  test.beforeEach(() => test.skip(moment !== "paddle", "Seed --moment=paddle for these"));

  test("10 with Glim on duty", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "10-on-duty",
      url: `${GALA}/paddle?paddle=142`,
      ready: async (p) => {
        await expect(region(p, "Bidding power")).toContainText("$500 held with PayPal");
        await expect(region(p, "Glim’s activity").getByRole("listitem")).toHaveCount(4);
      },
      actions: (p) => [
        region(p, "Bidding power").getByRole("link", { name: "Raise bidding power" }),
        region(p, "Glim’s activity").getByRole("button", { name: "Pause" }),
        region(p, "Glim’s activity").getByRole("button", { name: "Edit plan" }),
      ],
    });
  });

  test("10 with Glim paused", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "10-paused",
      url: `${GALA}/paddle?paddle=92`,
      ready: async (p) => {
        await expect(region(p, "Glim’s activity")).toContainText("Paused since 9:12 PM");
      },
      actions: (p) => [region(p, "Glim’s activity").getByRole("button", { name: "Resume" })],
    });
  });

  test("10 with no bids yet", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "10-no-bids",
      url: `${GALA}/paddle?paddle=119`,
      ready: async (p) => {
        await expect(region(p, "My lots")).toContainText("No bids yet");
      },
      actions: (p) => [
        region(p, "My lots").getByRole("link", { name: "See the lots" }),
        region(p, "Glim’s activity").getByRole("button", { name: "Talk to Glim" }),
      ],
    });
  });

  test("10 with bids and no plan", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "10-no-plan",
      url: `${GALA}/paddle?paddle=151`,
      ready: async (p) => {
        await expect(region(p, "My lots").getByRole("article")).toHaveCount(1);
        await expect(region(p, "Glim’s activity")).toContainText("Not bidding yet");
      },
    });
  });

  test("10 with a raise waiting in a PayPal window", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "10-raise-waiting",
      url: `${GALA}/paddle?paddle=109`,
      ready: async (p) => {
        await expect(region(p, "Bidding power").getByRole("status")).toHaveText("Finish in the PayPal window");
      },
    });
  });

  test("10 with no hold sends the guest to set bidding power first", async ({ page }) => {
    await atWidth(page, 375);
    // The redirect comes after the page starts streaming, so the browser follows it.
    await page.goto(`${GALA}/paddle?paddle=301`);
    await expect(page).toHaveURL(/\/power\?paddle=301/);
  });

  test("14 live", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "14-live",
      url: `${GALA}/projector`,
      fits: projectorFits,
      ready: async (p) => {
        await shown(p.getByText("$7,720"));
        await shown(p.getByRole("img", { name: /QR code for/ }));
      },
    });
  });

  test("14 before bidding opens", async ({ page }) => {
    const event = await eventRow();
    await pool().query("update events set status = 'scheduled', opens_at = '2026-11-08T05:45:00Z' where id = $1", [event.id]);
    try {
      await checkEveryWidth(page, {
        name: "14-before",
        url: `${GALA}/projector`,
        fits: projectorFits,
        ready: async (p) => {
          await shown(p.getByText("Bidding opens in"));
        },
      });
    } finally {
      await pool().query("update events set status = 'live', opens_at = $2 where id = $1", [event.id, event.opensAt]);
    }
  });
});

test.describe("the closed moment, bidding closed", () => {
  test.beforeEach(() => test.skip(moment !== "closed", "Seed --moment=closed for these"));

  const charged = async () => {
    const { rows } = await pool().query<{ n: number }>(
      "select count(*)::int as n from settlements s join events e on e.id = s.event_id where e.slug = $1",
      [SLUG],
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  test("11 pending, before the charge", async ({ page }) => {
    test.skip(await charged(), "Already charged: reseed --moment=closed to see pending");
    await checkEveryWidth(page, {
      name: "11-pending",
      url: `${GALA}/receipt?paddle=142`,
      ready: async (p) => {
        await shown(p.getByText("Thank you, Jamie."));
        await shown(p.getByText("to pay with PayPal"));
      },
    });
  });

  test("11 won nothing, the hold waiting to be released", async ({ page }) => {
    test.skip(await charged(), "Already charged: reseed --moment=closed to see release_pending");
    await checkEveryWidth(page, {
      name: "11-release-pending",
      url: `${GALA}/receipt?paddle=119`,
      ready: async (p) => {
        await shown(p.getByText("Your bids helped raise the total", { exact: false }));
        await shown(p.getByText("Hold releasing"));
      },
    });
  });

  test("11 never held", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "11-never-held",
      url: `${GALA}/receipt?paddle=302`,
      ready: async (p) => {
        await shown(p.getByText("Thank you, Robin."));
      },
    });
  });

  test("14 after the close", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "14-after",
      url: `${GALA}/projector`,
      fits: projectorFits,
      ready: async (p) => {
        await shown(p.getByText("Raised tonight"));
      },
    });
  });

  test("the charge goes through", async ({ page }) => {
    if (!(await charged())) {
      await page.goto(`${GALA}/organizer`, { waitUntil: "networkidle" });
      const started = await page.request.post(`/api/events/${SLUG}/settlement`, { data: {} });
      expect(started.status(), await started.text()).toBe(200);
    }
    await expect
      .poll(
        async () => {
          const { rows } = await pool().query<{ n: number }>(
            "select count(*)::int as n from receipts r join paddles p on p.id = r.paddle_id join events e on e.id = p.event_id where e.slug = $1 and p.number = 142",
            [SLUG],
          );
          return rows[0]?.n ?? 0;
        },
        { timeout: 60_000 },
      )
      .toBe(1);
  });

  test("11 paid", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "11-paid",
      url: `${GALA}/receipt?paddle=142`,
      ready: async (p) => {
        await shown(p.getByText("paid with PayPal"));
      },
      actions: (p) => [p.getByRole("link", { name: /Download receipt/ }), p.getByRole("link", { name: "Email me a copy" })],
    });
  });

  test("11 won nothing, released", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "11-released",
      url: `${GALA}/receipt?paddle=119`,
      ready: async (p) => {
        await shown(p.getByText("Your bids helped raise the total", { exact: false }));
        await shown(p.getByText("Hold released"));
      },
    });
  });

  test("25b the printable receipt", async ({ page }) => {
    await checkEveryWidth(page, {
      name: "25b-pdf",
      url: `${GALA}/receipt/pdf?paddle=142`,
      // The whole sheet, scaled down inside the stage's 16px sides where the screen is narrower.
      fits: (p, width) => expectInside(p, ".fh-pdf", width, null, width < 848 ? 16 : 0),
      ready: async (p) => {
        await shown(p.getByRole("img", { name: /Receipt PDF/ }));
      },
      actions: (p) => [p.getByRole("button", { name: "Download PDF" })],
    });
  });

  test("25b still prints as one US Letter page", async ({ page }) => {
    await atWidth(page, 375);
    await open(page, `${GALA}/receipt/pdf?paddle=142`);
    await page.emulateMedia({ media: "print" });
    const sheet = await page.locator(".fh-pdf").boundingBox();
    expect(sheet).toEqual({ x: 0, y: 0, width: 816, height: 1056 });
    const pdf = await page.pdf({ format: "Letter", printBackground: true, margin: { top: "0", right: "0", bottom: "0", left: "0" } });
    const pages = pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? [];
    expect(pages).toHaveLength(1);
  });
});
