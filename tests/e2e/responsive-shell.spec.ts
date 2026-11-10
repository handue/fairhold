import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  WIDTHS,
  atWidth,
  expectNoClippedText,
  expectNoHorizontalOverflow,
  expectTappableTargets,
  type Width,
} from "./support/responsive";

/**
 * The shared chrome and the entry pages below the approved 1440: the guest and organizer navs, the
 * role menu and its cards, the demo guide, 16 home, 16b join, 16c, the not-found pages and the
 * PayPal window pages. At 1440 fidelity.spec, guest-pages.spec and entry.spec hold them to the
 * boards. Needs a running database; the demo tests start their own demo gala.
 *
 *   NEXT_DIST_DIR=.next-r-shell PAYMENTS_MODE=simulated GLIM_MODE=recorded npx next dev -p 3501
 *   PLAYWRIGHT_BASE_URL=http://localhost:3501 npx playwright test tests/e2e/responsive-shell.spec.ts
 *
 * On event pages the body belongs to other screens, so the navs, the menus and the guide are
 * checked as regions here (expectRegionFits), and the whole page only on the pages this file owns.
 */
test.use({ channel: "chrome" });
test.setTimeout(240_000);

const GALA = /\/e\/gala-[0-9a-z]{16}$/;
const FIXTURE = "/e/riverside-shelter-gala";
const PHONE: Width = 375;
const nav = (page: Page) => page.getByRole("banner");

async function startDemo(page: Page): Promise<string> {
  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Start a demo gala" }).click();
  await page.waitForURL(GALA);
  return new URL(page.url()).pathname;
}

async function open(page: Page, width: Width, url: string) {
  await atWidth(page, width);
  await page.goto(url, { waitUntil: "networkidle" });
}

/** The whole page: nothing sideways and no text cut off. */
async function expectPageFits(page: Page, label: string) {
  await expectNoHorizontalOverflow(page, label);
  await expectNoClippedText(page, label);
}

/**
 * One region of a page this file does not own the body of: every visible part of it inside the
 * viewport, no text in it cut off without an ellipsis, and (with `tappable`) its links and buttons
 * at least 40px each way. The same rules as ./support/responsive.ts, scoped to the region.
 */
async function expectRegionFits(region: Locator, label: string, { tappable = false } = {}) {
  const report = await region.evaluate((root, checkTaps) => {
    const width = document.documentElement.clientWidth;
    const outside: string[] = [];
    const clipped: string[] = [];
    const small: string[] = [];
    const describe = (element: Element) =>
      `${element.tagName.toLowerCase()} "${(element.textContent ?? "").trim().slice(0, 30)}"`;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (element.closest("[aria-hidden=true], .sr-only")) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden") continue;
      if (rect.left < -1 || rect.right > width + 1) outside.push(`${describe(element)} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim());
      if (
        ownText &&
        style.textOverflow !== "ellipsis" &&
        /(hidden|clip)/.test(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1
      ) {
        clipped.push(describe(element));
      }
      if (checkTaps && element.matches("a[href], button, [role=menuitem], [role=menuitemradio]") && (rect.width < 40 || rect.height < 40)) {
        small.push(`${describe(element)} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
      }
    }
    return { outside, clipped, small };
  }, tappable);
  expect(report.outside, `${label} past the edge`).toEqual([]);
  expect(report.clipped, `${label} text cut off`).toEqual([]);
  expect(report.small, `${label} small tap targets`).toEqual([]);
}

async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not rendered");
  return box;
}

test("16 home fits every width, with the one action full width and above the fold on a phone", async ({ page }) => {
  for (const width of WIDTHS) {
    await open(page, width, "/");
    await expectPageFits(page, `home@${width}`);
    const title = page.getByRole("heading", { level: 1 });
    // Each sentence of the title keeps its one line.
    expect((await boxOf(title)).height, `home@${width} title lines`).toBeLessThan(2 * 70);
    const panel = page.getByRole("complementary", { name: "How a guest bids" });
    await expect(panel).toBeVisible();
  }

  await open(page, PHONE, "/");
  await expectTappableTargets(page, "home@375");
  const action = await boxOf(page.getByRole("button", { name: "Start a demo gala" }));
  expect(action.width).toBe(PHONE - 32);
  expect(action.height).toBeGreaterThanOrEqual(44);
  expect(action.y + action.height).toBeLessThan(812);
  // Below 1024 the product goes under the promise and the action.
  const panel = await boxOf(page.getByRole("complementary", { name: "How a guest bids" }));
  expect(panel.y).toBeGreaterThan(action.y + action.height);
});

test("16c, the not-found page and an event's missing page fit every width", async ({ page }) => {
  const pages = [
    { url: "/e/gala-0000000000000000", heading: "This demo gala has ended", action: "Start a new demo gala" },
    { url: "/not-a-fairhold-page", heading: "We could not find this page", action: "Start a demo gala" },
    { url: `${FIXTURE}/lots/99`, heading: "We could not find this page", action: "Back to the lots" },
  ];
  for (const { url, heading, action } of pages) {
    for (const width of WIDTHS) {
      await open(page, width, url);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectPageFits(page, `${url}@${width}`);
    }
    await open(page, PHONE, url);
    await expectTappableTargets(page, `${url}@375`);
    const button = await boxOf(page.getByRole("main").getByRole(action === "Back to the lots" ? "link" : "button", { name: action }));
    expect(button.width, `${url} action`).toBe(PHONE - 32);
    expect(button.height).toBeGreaterThanOrEqual(44);
  }
});

test("16b join fits every width, for a guest without a paddle", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const width of WIDTHS) {
    await open(page, width, `${FIXTURE}/join`);
    await expect(page.getByRole("heading", { name: "You’re invited" })).toBeVisible();
    await expectPageFits(page, `join@${width}`);
  }
  await open(page, PHONE, `${FIXTURE}/join`);
  await expectTappableTargets(page, "join@375");
  const field = await boxOf(page.getByLabel("First name"));
  const action = await boxOf(page.getByRole("button", { name: "Get my paddle" }));
  expect(field.width).toBe(PHONE - 32);
  expect(action.width).toBe(PHONE - 32);
  expect(action.y + action.height).toBeLessThan(812);
  await context.close();
});

test("the guest nav fits every width: one row from 1024, two below, and the demo guide folds", async ({ page }) => {
  const catalog = await startDemo(page);
  for (const width of WIDTHS) {
    await open(page, width, catalog);
    const header = nav(page);
    await expectRegionFits(header, `guest nav@${width}`, { tappable: width < 768 });
    await expect(header.getByText("Sandbox demo")).toBeVisible();
    await expect(header.getByRole("link", { name: "Lots" })).toBeVisible();
    await expect(header.getByRole("link", { name: "My paddle" })).toBeVisible();
    const bar = await boxOf(header);
    if (width >= 1024) {
      expect(bar.height, `guest nav@${width} is one row`).toBe(68);
      // Below 1440 the paddle mark lines up with the content's edge (43px at 1366, 32 by 1344).
      const mark = await boxOf(header.getByRole("link", { name: "Riverside Shelter Gala" }));
      const title = await boxOf(page.getByRole("heading", { name: "Tonight’s lots" }));
      expect(Math.abs(mark.x - title.x), `guest nav@${width} lines up with the content`).toBeLessThanOrEqual(6);
    } else {
      // Two rows: the name over the status, then the tabs; the tabs sit under the name.
      const name = await boxOf(header.getByRole("link", { name: "Riverside Shelter Gala" }));
      const tab = await boxOf(header.getByRole("link", { name: "Lots" }));
      expect(tab.y).toBeGreaterThan(name.y + name.height);
    }
    // Every width here is under 1280, or under 860 tall: the guide is the bar, not the docked card.
    await expectGuideFolds(page, width);
  }
  // From 1280 on a screen at least 860 tall, and at 1440, the approved card.
  for (const [width, height] of [[1280, 900], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.getByRole("complementary", { name: "Demo guide" })).toContainText("Charge winners and see your receipt");
  }
});

/** Below 1280 (and on short laptop screens) the guide is a bar that opens upwards, clear of Glim's orb and inside the screen. */
async function expectGuideFolds(page: Page, width: Width) {
  const guide = page.getByRole("complementary", { name: "Demo guide" });
  const toggle = guide.getByRole("button", { name: /Demo guide/ });
  await expect(toggle).toHaveAccessibleName("Demo guide · Step 1 of 5");
  await expectRegionFits(guide, `guide@${width}`, { tappable: true });
  const orb = await boxOf(page.getByRole("button", { name: "Chat with Glim" }));
  const closed = await boxOf(toggle);
  expect(closed.y + closed.height <= orb.y || closed.x + closed.width <= orb.x, `guide@${width} clear of the orb`).toBe(true);
  // On a phone from 360 the bar sits beside the orb, centred on its row; at 320 it sits above it.
  if (width < 768 && width >= 360) {
    expect(Math.abs(closed.y + closed.height / 2 - (orb.y + orb.height / 2)), `guide@${width} on the orb's row`).toBeLessThanOrEqual(1);
  }

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(guide.getByRole("listitem")).toHaveCount(5);
  await expectRegionFits(guide, `open guide@${width}`);
  const list = await boxOf(guide.getByRole("list"));
  expect(list.y + list.height <= orb.y || list.x + list.width <= orb.x, `open guide@${width} clear of the orb`).toBe(true);
  await toggle.click();
  await expect(guide.getByRole("list")).toHaveCount(0);
}

test("the creator's menu and its cards open inside the screen on a phone", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const catalog = await startDemo(page);
  for (const width of [320, 375] as const) {
    await open(page, width, catalog);
    const pill = nav(page).getByRole("button", { name: /142/ });
    await pill.click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expectRegionFits(menu, `menu@${width}`, { tappable: true });

    await menu.getByRole("menuitem", { name: "Invite a guest" }).click();
    const card = page.getByRole("dialog");
    await expect(card).toContainText("Invite a guest");
    await expectRegionFits(card, `invite card@${width}`, { tappable: true });
    await page.keyboard.press("Escape");
  }

  await open(page, PHONE, `${catalog}/organizer`);
  await nav(page).getByRole("button", { name: /Organizer/ }).click();
  await expectRegionFits(page.getByRole("menu"), "organizer menu@375", { tappable: true });
});

test("the organizer nav fits every width: one row from 1024, the tabs under the name below", async ({ page }) => {
  const catalog = await startDemo(page);
  for (const width of WIDTHS) {
    await open(page, width, `${catalog}/organizer`);
    const header = nav(page);
    await expectRegionFits(header, `organizer nav@${width}`, { tappable: width < 768 });
    const links = header.getByRole("navigation", { name: "Organizer" }).getByRole("link");
    await expect(links).toHaveText(["Control room", "Insights", "Projector"]);
    for (const link of await links.all()) await expect(link).toBeInViewport({ ratio: 1 });
    if (width >= 1024) expect((await boxOf(header)).height, `organizer nav@${width} is one row`).toBe(68);
  }
});

test("the PayPal window pages read as one column on a phone, with a full-width button", async ({ page }) => {
  const pages = [
    { url: `/paypal/start?e=riverside-shelter-gala&amount=50000`, heading: "Opening PayPal…", button: null },
    { url: "/paypal/cancel", heading: "We could not find this hold", button: "Back to the auction" },
  ];
  for (const { url, heading, button } of pages) {
    for (const width of WIDTHS) {
      await open(page, width, url);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectPageFits(page, `${url}@${width}`);
      // The trust line stays under the status block, never over it.
      const main = await boxOf(page.getByRole("main"));
      const foot = await boxOf(page.locator(".foot"));
      expect(foot.y, `${url}@${width} foot under the block`).toBeGreaterThanOrEqual(main.y + main.height - 1);
    }
    if (button) {
      await open(page, PHONE, url);
      await expectTappableTargets(page, `${url}@375`);
      const box = await boxOf(page.getByRole("link", { name: button }));
      expect(box.width).toBe(PHONE - 32);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  }
});
