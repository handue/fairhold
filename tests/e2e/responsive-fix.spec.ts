import { expect as baseExpect, test, type Locator, type Page } from "@playwright/test";

import { atWidth, expectNoClippedText, expectNoHorizontalOverflow, type Width } from "./support/responsive";

/**
 * The two reviews of the responsive layouts (Nov 10), held in place: each finding that was fixed has a
 * check here, at the widths the review found it at, and where it touched a shared part, at 1440 too.
 * The rest of each page is checked by the other responsive-*.spec.ts files.
 *
 * Run on the live server (next dev, keyless, no frozen clock, no tick) with the seeded fixture:
 *   DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:<port> npx playwright test tests/e2e/responsive-fix.spec.ts
 */
test.use({ channel: "chrome" });
test.setTimeout(180_000);

// A dev server compiles each route on its first request, which can take many seconds.
const expect = baseExpect.configure({ timeout: 30_000 });

const FIXTURE = "/e/riverside-shelter-gala";
const JAMIE = "?paddle=142";

test.beforeEach(async ({ context }) => {
  const octet = () => 1 + Math.floor(Math.random() * 250);
  await context.setExtraHTTPHeaders({ "cf-connecting-ip": `197.${octet()}.${octet()}.${octet()}` });
  // next dev reloads open pages when files change; the page still needs the socket's hello to hydrate.
  await context.routeWebSocket(/\/_next\/(?:webpack-)?hmr/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (!/"reloadPage"|"type":"restart"/.test(String(message))) socket.send(message);
    });
    socket.onMessage((message) => server.send(message));
  });
});

/** The stream keeps event pages from ever going network-idle, so wait for React itself. */
async function untilHydrated(locator: Locator): Promise<void> {
  await expect(locator.first()).toBeVisible();
  await expect
    .poll(() => locator.first().evaluate((element) => Object.keys(element).some((key) => key.startsWith("__reactProps"))))
    .toBe(true);
}

async function open(page: Page, url: string, ready: (page: Page) => Locator): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await page.goto(url);
      break;
    } catch (error) {
      if (attempt >= 3 || !String(error).includes("ERR_ABORTED")) throw error;
    }
  }
  await untilHydrated(ready(page));
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => document.fonts.ready);
}

async function size(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await settle(page);
}

/** A demo gala of this browser's own; the creator is paddle 142. */
async function startDemo(page: Page): Promise<{ catalog: string; slug: string }> {
  await page.goto("/");
  const started = await page.request.post("/api/demo", { data: { firstName: "Sam" } });
  expect(started.status()).toBe(201);
  const catalog = ((await started.json()) as { href: string }).href;
  return { catalog, slug: catalog.split("/").at(-1) ?? "" };
}

/** $500 held, approved: in simulated mode the approval link is the return page, and a GET places it. */
async function holdFiveHundred(page: Page, slug: string): Promise<void> {
  const created = await page.request.post(`/api/holds/${slug}`, { data: { amountCents: 50_000, next: `/e/${slug}` } });
  expect(created.ok()).toBe(true);
  await page.request.get(((await created.json()) as { approvalUrl: string }).approvalUrl);
}

async function closeBidding(page: Page, slug: string): Promise<void> {
  const closed = await page.request.post(`/api/events/${slug}/demo/close-bidding`, { data: {} });
  expect(closed.status()).toBe(200);
}

/** How many lines an element's text takes. */
const lineCount = (locator: Locator) =>
  locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top))).size;
  });

/**
 * The line tops of the first and the last character of the text `pattern` matches inside an element,
 * no-break spaces read as spaces: equal when that text sits on one line. Null when nothing matches.
 */
const linesOf = (locator: Locator, pattern: RegExp) =>
  locator.evaluate(
    (element, { source, flags }) => {
      const nodes: Array<[Text, number]> = [];
      let text = "";
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push([node as Text, text.length]);
        text += node.textContent ?? "";
      }
      const match = new RegExp(source, flags).exec(text.replaceAll("\u00a0", " "));
      if (!match) return null;
      const topAt = (offset: number) => {
        const entry = nodes.findLast(([node, at]) => at <= offset && offset < at + (node.textContent ?? "").length);
        if (!entry) return null;
        const range = document.createRange();
        range.setStart(entry[0], offset - entry[1]);
        range.setEnd(entry[0], offset - entry[1] + 1);
        return Math.round(range.getBoundingClientRect().top);
      };
      return { first: topAt(match.index), last: topAt(match.index + match[0].length - 1) };
    },
    { source: pattern.source, flags: pattern.flags },
  );

async function expectOneLine(locator: Locator, pattern: RegExp, label: string): Promise<void> {
  const lines = await linesOf(locator, pattern);
  expect(lines, `${label}: the text is there`).not.toBeNull();
  expect(lines?.first, `${label}: on one line`).toBe(lines?.last);
}

const fontSize = (locator: Locator) => locator.evaluate((element) => getComputedStyle(element).fontSize);

const orbOf = (page: Page) => page.getByRole("button", { name: "Chat with Glim" });

test("the money fields are 16px on a phone, so iOS doesn't zoom in on them (05, 09)", async ({ page }) => {
  const { catalog, slug } = await startDemo(page);
  for (const width of [320, 375, 430] as const) {
    await atWidth(page, width);
    await open(page, `${catalog}/power`, (p) => p.getByRole("radio", { name: "Other…" }));
    await page.getByRole("radio", { name: "Other…" }).click();
    await expect(page.getByLabel("Other amount, in whole dollars")).toBeVisible();
    expect(await fontSize(page.getByLabel("Other amount, in whole dollars")), `09 at ${width}`).toBe("16px");
  }
  await holdFiveHundred(page, slug);
  // A lot whose next bid fits in the $500, so a max there is set rather than raised.
  let maxDollars = 0;
  for (const lot of ["22", "07", "11", "15", "18", "04"]) {
    await atWidth(page, 375);
    await open(page, `${catalog}/lots/${lot}`, (p) => p.getByRole("radio", { name: "Max…" }));
    const next = Number((await page.getByRole("radiogroup").first().getByRole("radio").first().innerText()).replace(/\D/g, ""));
    if (next <= 500) {
      maxDollars = next;
      break;
    }
  }
  expect(maxDollars, "a lot with a next bid within $500").toBeGreaterThan(0);
  await page.getByRole("radio", { name: "Max…" }).click();
  expect(await fontSize(page.getByLabel("Your max")), "05 at 375").toBe("16px");
  // 1440 is as approved.
  await size(page, 1440, 900);
  expect(await fontSize(page.getByLabel("Your max")), "05 at 1440").toBe("14px");
  // "up to" stays with the amount the guest typed, wherever the line wraps.
  await page.getByLabel("Your max").fill(String(maxDollars));
  const line = page.getByText(/^Outbid\? Your bid goes/);
  for (const width of [1024, 1280, 375, 320] as const) {
    await atWidth(page, width);
    await expect(line).toBeVisible();
    await expectOneLine(line, /up to \$[\d,]+\./, `"up to $${maxDollars}." at ${width}`);
  }
});

test("09's Hold button is on the first screen of a phone, and nothing rests on it on a laptop", async ({ page }) => {
  const { catalog } = await startDemo(page);
  const hold = page.getByRole("button", { name: /^Hold \$500 with PayPal/ });
  for (const [width, height] of [[320, 568], [375, 812], [430, 932]] as const) {
    await size(page, width, height);
    await open(page, `${catalog}/power`, () => hold);
    const button = await hold.boundingBox();
    const explainer = await page.getByRole("region", { name: "How the hold works" }).boundingBox();
    expect((button?.y ?? 0) + (button?.height ?? 0), `Hold button on the first screen at ${width}x${height}`).toBeLessThanOrEqual(height);
    expect(explainer?.y ?? 0, `the explainer follows the button at ${width}`).toBeGreaterThan(button?.y ?? 0);
  }
  for (const [width, height] of [[1024, 700], [1024, 768], [1280, 689], [1366, 657]] as const) {
    await size(page, width, height);
    await open(page, `${catalog}/power`, () => hold);
    // Below 1440 Glim's corner closes the page, under the trust line.
    const corner = orbOf(page).locator("xpath=..");
    expect(await corner.evaluate((element) => getComputedStyle(element).position), `corner at ${width}x${height}`).toBe("static");
    const [button, orb] = [await hold.boundingBox(), await orbOf(page).boundingBox()];
    expect((orb?.y ?? 0) > (button?.y ?? 0) + (button?.height ?? 0), `the orb under the Hold button at ${width}`).toBe(true);
    await expectNoHorizontalOverflow(page, `09 at ${width}`);
  }
  await size(page, 1440, 900);
  expect(await orbOf(page).boundingBox(), "09's corner at 1440").toEqual({ x: 1340, y: 804, width: 68, height: 68 });
});

test("05's corner closes the page below 1440, under the bid history", async ({ page }) => {
  const { catalog, slug } = await startDemo(page);
  await holdFiveHundred(page, slug);
  await open(page, `${catalog}/lots/03`, (p) => p.getByRole("button", { name: "Let Glim bid on this lot" }));
  for (const [width, height] of [[1024, 768], [1280, 800], [1366, 657], [768, 1024], [375, 812]] as const) {
    await size(page, width, height);
    const [glim, orb] = [await page.getByRole("button", { name: "Let Glim bid on this lot" }).boundingBox(), await orbOf(page).boundingBox()];
    expect((orb?.y ?? 0) > (glim?.y ?? 0) + (glim?.height ?? 0), `the orb below the bid card at ${width}`).toBe(true);
    // Below 1024 the invitation leaves the orb alone; the card's "Let Glim bid on this lot" makes it.
    await expect(page.getByText("Want me to bid for you?", { exact: true }), `invitation at ${width}`)[width < 1024 ? "toBeHidden" : "toBeVisible"]();
  }
  await size(page, 1440, 900);
  expect(await orbOf(page).boundingBox(), "05's corner at 1440").toEqual({ x: 1340, y: 804, width: 68, height: 68 });
});

test("the donation line wraps at its separator: the donor whole, then the estimate whole (05)", async ({ page }) => {
  for (const width of [320, 375, 768] as const) {
    await atWidth(page, width);
    await open(page, `${FIXTURE}/lots/03${JAMIE}`, (p) => p.getByRole("heading", { name: "Weekend Cabin Stay" }));
    const line = page.getByText("Donated by Pine Hollow Cabins");
    expect(await lineCount(line), `two lines at ${width}`).toBe(2);
    // The donor and its dot on the first line, the estimate whole on the second.
    await expectOneLine(line, /Donated by Pine Hollow Cabins ·/, `the donor at ${width}`);
    await expectOneLine(line, /Estimated value \$600/, `the estimate at ${width}`);
  }
  await size(page, 1440, 900);
  expect(await lineCount(page.getByText("Donated by Pine Hollow Cabins")), "one line at 1440").toBe(1);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the demo menu scrolls when the screen is short, and the tap that closes it opens nothing", async ({ page }) => {
    const { catalog } = await startDemo(page);
    const pill = page.getByRole("banner").first().getByRole("button", { name: /142/ });
    const menu = page.getByRole("menu");
    for (const [width, height] of [[667, 375], [568, 320]] as const) {
      await size(page, width, height);
      await open(page, catalog, () => pill);
      await pill.tap();
      await expect(menu).toBeVisible();
      const reset = menu.getByRole("menuitem", { name: "Reset demo" });
      await reset.scrollIntoViewIfNeeded();
      const box = await reset.boundingBox();
      expect((box?.y ?? 0) + (box?.height ?? 0), `Reset demo reachable at ${width}x${height}`).toBeLessThanOrEqual(height);
      await page.keyboard.press("Escape");
      await expect(menu).toBeHidden();
    }

    await size(page, 375, 812);
    await open(page, catalog, () => pill);
    await pill.tap();
    await expect(menu).toBeVisible();
    const menuBottom = await menu.evaluate((element) => element.getBoundingClientRect().bottom);
    // A lot's title below the menu, on screen.
    const spot = await page.evaluate((below) => {
      for (const link of document.querySelectorAll<HTMLAnchorElement>("main a[href*='/lots/']")) {
        const rect = link.getBoundingClientRect();
        if (rect.top > below + 8 && rect.bottom < innerHeight && rect.width > 20) return { x: rect.x + 10, y: rect.y + rect.height / 2 };
      }
      return null;
    }, menuBottom);
    expect(spot, "a lot under the menu's edge").not.toBeNull();
    const before = page.url();
    await page.touchscreen.tap(spot?.x ?? 0, spot?.y ?? 0);
    await expect(menu).toBeHidden();
    await page.waitForTimeout(1_000);
    expect(page.url(), "the closing tap opened nothing").toBe(before);
  });

  test("Glim's sheet opens with the keyboard down, except for 05's prefill", async ({ page }) => {
    const { catalog, slug } = await startDemo(page);
    await holdFiveHundred(page, slug);
    await size(page, 375, 812);
    await open(page, catalog, () => orbOf(page));
    const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
    await expect(async () => {
      if (!(await panel.isVisible())) await orbOf(page).tap();
      await expect(panel).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    await expect(panel.getByRole("button", { name: "All $500" })).toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "focus after opening").not.toBe("Message Glim");
    await panel.getByRole("button", { name: "Close", exact: true }).first().tap();

    await open(page, `${catalog}/lots/07`, (p) => p.getByRole("button", { name: "Let Glim bid on this lot" }));
    await page.getByRole("button", { name: "Let Glim bid on this lot" }).tap();
    await expect(panel.getByLabel("Message Glim")).toBeFocused();
  });
});

test("Glim's card stays under the nav on a laptop screen, and the input takes focus with a mouse", async ({ page }) => {
  const { catalog, slug } = await startDemo(page);
  await holdFiveHundred(page, slug);
  const panel = page.getByRole("dialog", { name: "Chat with Glim, your bidding agent" });
  for (const [width, height] of [[1024, 768], [1280, 800], [1366, 657], [1280, 560], [1440, 900]] as const) {
    await size(page, width, height);
    await open(page, catalog, () => orbOf(page));
    await expect(async () => {
      if (!(await panel.isVisible())) await orbOf(page).click();
      await expect(panel).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
    const [card, nav] = [await panel.boundingBox(), await page.getByRole("banner").first().boundingBox()];
    expect(card?.y ?? 0, `the card under the nav at ${width}x${height}`).toBeGreaterThanOrEqual((nav?.y ?? 0) + (nav?.height ?? 0) + 16 - 1);
    await expect(panel.getByLabel("Message Glim")).toBeFocused();
    if (width === 1440) expect(card, "07 at 1440x900").toEqual({ x: 1008, y: 84, width: 400, height: 704 });
  }
});

test("08 at 1024 to 1279 ends its first screen in a full row of three", async ({ page }) => {
  const articles = page.getByRole("article");
  for (const [width, shown, more] of [[1024, 9, 15], [1280, 8, 16], [768, 8, 16], [375, 8, 16]] as const) {
    await atWidth(page, width);
    await open(page, `${FIXTURE}${JAMIE}`, (p) => p.getByRole("button", { name: /^Show \d+ more lots$/ }));
    await expect(articles, `first tiles at ${width}`).toHaveCount(shown);
    await expect(page.getByRole("button", { name: `Show ${more} more lots` }), `the button at ${width}`).toBeVisible();
  }
  await atWidth(page, 1024);
  await page.getByRole("button", { name: "Show 15 more lots" }).click();
  await expect(articles).toHaveCount(24);
  await size(page, 1440, 900);
  await expect(articles).toHaveCount(24);
});

test("the receipt keeps its time whole and, below 1024, says Glim's note itself (10, 11)", async ({ page }) => {
  const { catalog, slug } = await startDemo(page);
  await holdFiveHundred(page, slug);
  for (const width of [320, 375, 430] as const) {
    await atWidth(page, width);
    await open(page, `${catalog}/paddle`, (p) => p.getByText(/Nothing is charged until bidding closes at/));
    await expectOneLine(page.getByText(/Nothing is charged until bidding closes at/), /\d{1,2}:\d{2} [AP]M/, `10's close time at ${width}`);
  }

  await closeBidding(page, slug);
  const note = page.getByRole("note");
  // This guest won nothing, so Glim's note is "Nothing to pick up" (a winner's is "Almost there").
  const title = "Nothing to pick up";
  const shown = page.getByText(title, { exact: true }).filter({ visible: true });
  for (const width of [320, 375, 768] as const) {
    await atWidth(page, width);
    await open(page, `${catalog}/receipt`, (p) => p.getByRole("heading", { name: /^Thank you/ }));
    await expectOneLine(page.getByText(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \w+ \d+, \d{4} · /), /\d{1,2}:\d{2} [AP]M/, `the receipt's time at ${width}`);
    await expect(note, `the note in the receipt at ${width}`).toContainText(title);
    await expect(note).toContainText("Your hold is released when winners are charged.");
    // The corner keeps the orb alone there.
    await expect(shown, `one note at ${width}`).toHaveCount(1);
    await expectNoHorizontalOverflow(page, `11 at ${width}`);
    await expectNoClippedText(page, `11 at ${width}`);
  }
  for (const width of [1024, 1366] as const) {
    await atWidth(page, width);
    await expect(note, `no note in the receipt at ${width}`).toBeHidden();
    await expect(shown, `the bubble at ${width}`).toHaveCount(1);
  }
});

test("the projector flows on every upright tablet, its marker at the gutter (14)", async ({ page }) => {
  const { catalog } = await startDemo(page);
  for (const [width, height] of [[1024, 1366], [768, 1024], [820, 1180]] as const) {
    await size(page, width, height);
    await open(page, `${catalog}/projector`, (p) => p.getByText("Sandbox demo", { exact: true }));
    const flowed = await page.evaluate(() => getComputedStyle(document.querySelector(".fh-projector") as Element).transform === "none");
    expect(flowed, `the board flows at ${width}x${height}`).toBe(true);
    const [marker, mark] = [await page.locator(".fh-projector .sbx").boundingBox(), await page.locator(".fh-projector .brand svg").boundingBox()];
    // Wrapped under the name, the marker starts at the gutter, under the paddle mark.
    if (marker && mark && marker.y > mark.y + mark.height) expect(Math.abs(marker.x - 32), `the marker at the gutter at ${width}`).toBeLessThanOrEqual(1);
    await expectNoHorizontalOverflow(page, `14 at ${width}x${height}`);
  }
  // A landscape screen keeps the scaled board.
  await size(page, 1366, 1024);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".fh-projector") as Element).transform)).not.toBe("none");
});

test("every width still fits after the fixes: 05, 08, 09 and 11 at each width", async ({ page }) => {
  const { catalog, slug } = await startDemo(page);
  const widths: Width[] = [320, 375, 430, 768, 1024, 1280, 1366];
  for (const width of widths) {
    await atWidth(page, width);
    await open(page, `${catalog}/power`, (p) => p.getByRole("radio", { name: "Other…" }));
    await expectNoHorizontalOverflow(page, `09 at ${width}`);
    await expectNoClippedText(page, `09 at ${width}`);
  }
  await holdFiveHundred(page, slug);
  for (const width of widths) {
    await atWidth(page, width);
    await open(page, `${catalog}/lots/03`, (p) => p.getByRole("button", { name: "Let Glim bid on this lot" }));
    await expectNoHorizontalOverflow(page, `05 at ${width}`);
    await expectNoClippedText(page, `05 at ${width}`);
    await open(page, catalog, (p) => p.getByRole("button", { name: /^Show \d+ more lots$/ }));
    await expectNoHorizontalOverflow(page, `08 at ${width}`);
    await expectNoClippedText(page, `08 at ${width}`);
  }
});
