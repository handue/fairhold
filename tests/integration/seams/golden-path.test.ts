/**
 * The golden path, end to end on Postgres with simulated payments and recorded Glim, through the route
 * handlers a browser calls: start a demo, hold $500, bid, say the golden sentence, Start bidding, the
 * rival's $400 on Chef's Table, Glim moves the $380 left to Wine Tasting with a $220 bid, close
 * bidding, charge the winners. The guest's won total is captured, every other hold is voided, and at
 * no step does the guest's spending pass the $500 they named.
 *
 * The test holds the clock only for the director's jobs, which take it as an argument. Everything else
 * runs as the tick runs it: the tasks from src/instrumentation.ts, in that order.
 *
 * The autopilot's switch is on as shipped, now that V1 (design/21) is approved, so the path below is
 * the app as it ships. The last test turns it off, as GLIM_AUTOPILOT=off would.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as startDemoRoute } from "@/app/api/demo/route";
import { POST as demoControlRoute } from "@/app/api/events/[slug]/demo/[action]/route";
import { POST as joinRoute } from "@/app/api/events/[slug]/join/route";
import { POST as bidRoute } from "@/app/api/events/[slug]/lots/[number]/bid/route";
import { POST as favoriteRoute } from "@/app/api/events/[slug]/lots/[number]/favorite/route";
import { POST as checksRoute } from "@/app/api/events/[slug]/settlement/checks/route";
import { GET as ledgerRoute, POST as chargeRoute } from "@/app/api/events/[slug]/settlement/route";
import { POST as messageRoute } from "@/app/api/glim/[slug]/messages/route";
import { POST as confirmRoute } from "@/app/api/glim/[slug]/plans/[planId]/confirm/route";
import { GET as chatViewRoute } from "@/app/api/glim/[slug]/route";
import { GET as holdStatusRoute } from "@/app/api/holds/[slug]/[holdId]/route";
import { POST as openHoldRoute } from "@/app/api/holds/[slug]/route";
import { GET as pollRoute } from "@/app/api/stream/poll/route";
import { GET as paypalReturnRoute } from "@/app/paypal/return/route";
import { getSession } from "@/server/api";
import { createEventCardTickTask } from "@/server/chat/task";
import type { ChatStreamFrame, ChatView, PlanCardView } from "@/server/chat/types";
import { scheduleReactions } from "@/server/director/reactions";
import { runDueJobs } from "@/server/director/run";
import { getBiddingPower, getCommitments, placeBid } from "@/server/engine";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";
import { createAutopilotTickTask } from "@/server/plans/task";
import { getCatalogView } from "@/server/queries/catalog";
import { readPaddleGlim } from "@/server/queries/paddle";
import { settlementRunnerIdle, type LedgerView } from "@/server/settlement";
import type { ReceiptGlimRecap, ReceiptLine } from "@/server/settlement";
import { closeStreamHub } from "@/server/sse/hub";
import { ORGANIZER_STREAM_TYPES, type StreamEvent, type StreamPollResponse } from "@/server/sse/types";
import { readChatFrames } from "@/ui/glim/frames";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { cookieFrom, postJson, withCookie } from "../api/support";
import { makeDue } from "../plans/support";
import { openStream, type StreamReader } from "../sse/support";

const armed = vi.hoisted(() => ({ on: true }));
vi.mock("@/server/chat/switch", async (importOriginal) => {
  const shipped = await importOriginal<typeof import("@/server/chat/switch")>();
  return { ...shipped, planCardsArmAutopilot: () => armed.on && shipped.planCardsArmAutopilot() };
});

const database = getTestDatabase();
const { pool } = database;

const LOT_CHEFS_TABLE = 7;
const LOT_WINE_TASTING = 9;
const LOT_SPA_DAY = 12;
const LOT_CABIN = 3;
const LOT_KAI_BIDS_ON = 5;
/** Rows arrive in milliseconds; this allows for a machine under load. */
const STREAM_WAIT_MS = 10_000;

const params = <T extends Record<string, string>>(values: T) => ({ params: Promise.resolve(values) });

interface Guest {
  slug: string;
  cookie: string;
  paddleId: string;
  paddleNumber: number;
}

interface HoldRow {
  id: string;
  status: string;
  amount_cents: number;
  original_authorization_id: string | null;
  current_authorization_id: string | null;
}

const rows = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> =>
  (await pool.query<T>(text, values)).rows;

async function jsonOf<T>(response: Response, status = 200): Promise<T> {
  const body: unknown = await response.json();
  if (response.status !== status) throw new Error(`Answered ${response.status}, not ${status}: ${JSON.stringify(body)}`);
  return body as T;
}

const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; details: Record<string, number> } }).error;

async function guestFromCookie(slug: string, cookie: string): Promise<Guest> {
  const session = await getSession(slug, withCookie(cookie));
  if (!session?.paddleId || session.paddleNumber === null) throw new Error("The cookie carries no paddle");
  return { slug, cookie, paddleId: session.paddleId, paddleNumber: session.paddleNumber };
}

// What the browser does ------------------------------------------------------------------------------

async function startDemo(firstName = "Jamie"): Promise<Guest> {
  const response = await startDemoRoute(postJson("/api/demo", { firstName, timeZone: "America/Los_Angeles" }), undefined);
  const { slug } = await jsonOf<{ slug: string }>(response.clone(), 201);
  return guestFromCookie(slug, cookieFrom(response));
}

async function join(slug: string, firstName: string): Promise<Guest> {
  const response = await joinRoute(postJson(`/api/events/${slug}/join`, { firstName }), params({ slug }));
  await jsonOf(response.clone(), 201);
  return guestFromCookie(slug, cookieFrom(response));
}

/** POST /api/holds, then the window: in keyless mode the approval URL is the return page itself. */
async function holdWithPaypal(guest: Guest, amountCents: number): Promise<string> {
  const opened = await openHoldRoute(postJson(`/api/holds/${guest.slug}`, { amountCents }, { cookie: guest.cookie }), params({ slug: guest.slug }));
  const { holdId, approvalUrl } = await jsonOf<{ holdId: string; approvalUrl: string }>(opened, 201);
  const page = await paypalReturnRoute(new Request(new URL(approvalUrl, "https://fairhold.example")));
  expect(page.status).toBe(200);
  const status = await holdStatusRoute(withCookie(guest.cookie), params({ slug: guest.slug, holdId }));
  expect(await jsonOf(status)).toMatchObject({ status: "authorized", amountCents });
  return holdId;
}

const bid = (guest: Guest, lotNumber: number, amountCents: number) =>
  bidRoute(postJson(`/api/events/${guest.slug}/lots/${lotNumber}/bid`, { amountCents }, { cookie: guest.cookie }), params({ slug: guest.slug, number: String(lotNumber) }));

async function heart(guest: Guest, lotNumber: number): Promise<void> {
  const response = await favoriteRoute(
    postJson(`/api/events/${guest.slug}/lots/${lotNumber}/favorite`, { favorite: true }, { cookie: guest.cookie }),
    params({ slug: guest.slug, number: String(lotNumber) }),
  );
  await jsonOf(response);
}

async function say(guest: Guest, text: string): Promise<ChatView> {
  const response = await messageRoute(postJson(`/api/glim/${guest.slug}/messages`, { text }, { cookie: guest.cookie }), params({ slug: guest.slug }));
  if (!response.ok || !response.body) throw new Error(`Glim answered ${response.status}: ${await response.text()}`);
  let view: ChatView | null = null;
  await readChatFrames(response.body, (frame: ChatStreamFrame) => {
    if (frame.type === "error") throw new Error(`Glim failed: ${frame.code}`);
    if (frame.type === "done") view = frame.view;
  });
  if (!view) throw new Error("Glim's answer had no view");
  return view;
}

const chatView = async (guest: Guest): Promise<ChatView> =>
  jsonOf(await chatViewRoute(withCookie(guest.cookie), params({ slug: guest.slug })));

function planCardOf(view: ChatView): PlanCardView {
  const card = [...view.messages].reverse().find((message) => message.card?.type === "plan")?.card;
  if (card?.type !== "plan") throw new Error("No plan card in the chat");
  return card;
}

const eventLines = (view: ChatView) => view.messages.flatMap((message) => (message.card?.type === "event" ? [message.card.line] : []));

const startBidding = async (guest: Guest, planId: string): Promise<ChatView> =>
  jsonOf(await confirmRoute(postJson(`/api/glim/${guest.slug}/plans/${planId}/confirm`, {}, { cookie: guest.cookie }), params({ slug: guest.slug, planId })));

const control = (guest: Guest, action: string) =>
  demoControlRoute(postJson(`/api/events/${guest.slug}/demo/${action}`, {}, { cookie: guest.cookie }), params({ slug: guest.slug, action }));

const ledger = async (guest: Guest): Promise<LedgerView> => jsonOf(await ledgerRoute(withCookie(guest.cookie), params({ slug: guest.slug })));

// What the tick does ---------------------------------------------------------------------------------

/** The director's rivals and bots, on the test's clock. */
async function runDirectorUntil(now: Date) {
  await scheduleReactions(pool);
  return runDueJobs({ pool, now });
}

/** When a rival bids. Asking queues the rivals first, as the tick's next round would. */
async function rivalJob(eventSlug: string, kind: "rival_under_limit" | "rival_over_limit"): Promise<Date> {
  await scheduleReactions(pool);
  const [job] = await rows<{ run_at: Date }>(
    `select j.run_at from director_jobs j join events e on e.id = j.event_id where e.slug = $1 and j.kind = $2`,
    [eventSlug, kind],
  );
  if (!job) throw new Error(`No ${kind} job`);
  return job.run_at;
}

/** One round of the tick's Glim tasks, in instrumentation.ts's order, past the autopilot's debounce. */
async function tickGlim(guest: Guest): Promise<void> {
  const eventCards = createEventCardTickTask();
  const autopilot = createAutopilotTickTask();
  await eventCards.run();
  await autopilot.run();
  await makeDue(pool, guest.paddleId);
  await autopilot.run();
  await autopilot.idle();
  await eventCards.run();
}

// What the checks read -------------------------------------------------------------------------------

const lotNumbered = async (slug: string, number: number) => {
  const [lot] = await rows<{ id: string; current_bid_cents: number | null; high_paddle_id: string | null; high_bid_source: string | null; status: string; winning_paddle_id: string | null; winning_cents: number | null }>(
    `select l.id, l.current_bid_cents, l.high_paddle_id, l.high_bid_source, l.status, l.winning_paddle_id, l.winning_cents
     from lots l join events e on e.id = l.event_id where e.slug = $1 and l.number = $2`,
    [slug, number],
  );
  if (!lot) throw new Error(`No lot ${number}`);
  return lot;
};

const nav = async (guest: Guest) => (await getCatalogView({ slug: guest.slug, paddleNumber: guest.paddleNumber, category: null }))?.viewer;

const holdOf = async (holdId: string): Promise<HoldRow> => {
  const [hold] = await rows<HoldRow & Record<string, unknown>>(
    "select id, status, amount_cents, original_authorization_id, current_authorization_id from holds where id = $1",
    [holdId],
  );
  if (!hold) throw new Error("No such hold");
  return hold;
};

/**
 * The promise the whole product makes: everything the guest could end up paying, on every lot they
 * lead or have a limit on, stays within the budget they named and within the hold.
 */
async function expectSpendingWithin(guest: Guest, budgetCents: number): Promise<number> {
  const power = (await getBiddingPower([guest.paddleId], pool)).get(guest.paddleId);
  const commitments = await getCommitments([guest.paddleId], pool);
  const committed = commitments.reduce((sum, row) => sum + row.cents, 0);
  expect(committed).toBeLessThanOrEqual(budgetCents);
  if (power?.holdCents) expect(committed).toBeLessThanOrEqual(power.holdCents);
  return committed;
}

// The story up to Glim's move ------------------------------------------------------------------------

/** Start a demo; Kai joins; Jamie holds $500, hearts Wine Tasting, bids $320 and tells Glim the golden sentence. */
async function upToStartBidding() {
  const jamie = await startDemo();
  const kai = await join(jamie.slug, "Kai");
  const holdId = await holdWithPaypal(jamie, 50_000);
  await heart(jamie, LOT_WINE_TASTING);
  expect(await jsonOf<{ leading: boolean }>(await bid(jamie, LOT_CHEFS_TABLE, 32_000))).toMatchObject({ leading: true });
  const view = await say(jamie, GOLDEN_SENTENCE);
  const card = planCardOf(view);
  return { jamie, kai, holdId, card };
}

async function theRivalsAndGlimsMove(jamie: Guest): Promise<void> {
  await runDirectorUntil(await rivalJob(jamie.slug, "rival_under_limit"));
  await tickGlim(jamie);
  await runDirectorUntil(await rivalJob(jamie.slug, "rival_over_limit"));
  await tickGlim(jamie);
}

afterAll(() => closeStreamHub());

beforeEach(async () => {
  armed.on = true;
  await pool.query("delete from events");
  await pool.query("delete from rate_limits");
});

afterEach(() => settlementRunnerIdle());

describe("the golden path", () => {
  it("runs from a new demo to the winners charged, within the guest's $500", async () => {
    // A new demo: paddle 142, an organizer of this event alone, with no bidding power yet.
    const jamie = await startDemo();
    expect(jamie.paddleNumber).toBe(142);
    expect(await getSession(jamie.slug, withCookie(jamie.cookie))).toMatchObject({ isOrganizer: true, firstName: "Jamie" });
    expect(await nav(jamie)).toMatchObject({ paddleNumber: 142, firstName: "Jamie", holdCents: null });
    const noHold = await bid(jamie, LOT_CHEFS_TABLE, 32_000);
    expect(noHold.status).toBe(409);
    expect(await errorOf(noHold)).toMatchObject({ code: "no_hold" });

    // Kai joins by the invite link, and watches through a stream of his own.
    const invite = await jsonOf<{ href: string }>(await control(jamie, "invite"));
    expect(invite.href).toBe(`/e/${jamie.slug}/join`);
    const kai = await join(jamie.slug, "Kai");
    expect(kai.paddleNumber).not.toBe(142);
    expect(await nav(kai)).toMatchObject({ firstName: "Kai", holdCents: null });

    const jamieStream: StreamReader = await (await openStream({ slug: jamie.slug, cookie: jamie.cookie })).ready();
    const kaiStream: StreamReader = await (await openStream({ slug: jamie.slug, cookie: kai.cookie })).ready();
    const position = jamieStream.hello.latest;

    try {
      // Hold $500 in the PayPal window: the nav and the engine read the same bidding power.
      const jamieHold = await holdWithPaypal(jamie, 50_000);
      expect(await holdOf(jamieHold)).toMatchObject({ status: "authorized", amount_cents: 50_000 });
      expect(await nav(jamie)).toMatchObject({ holdCents: 50_000, availableCents: 50_000 });
      expect((await getBiddingPower([jamie.paddleId], pool)).get(jamie.paddleId)).toMatchObject({ holdCents: 50_000, availableCents: 50_000 });

      // The hold reaches Jamie's browser, and only hers.
      await jamieStream.waitFor((frame) => frame.event === "hold" && (frame.data as StreamEvent).paddleId === jamie.paddleId, STREAM_WAIT_MS);
      expect(kaiStream.rows.filter((row) => row.type === "hold")).toEqual([]);

      // A bid: Jamie takes Chef's Table at $320, and Kai's browser hears it.
      await heart(jamie, LOT_WINE_TASTING);
      expect(await jsonOf(await bid(jamie, LOT_CHEFS_TABLE, 32_000))).toMatchObject({ leading: true });
      await kaiStream.waitFor((frame) => frame.event === "bid" && (frame.data as { payload: { kind: string } }).payload.kind === "bids_placed", STREAM_WAIT_MS);
      expect(await nav(jamie)).toMatchObject({ holdCents: 50_000, availableCents: 18_000, winningCount: 1 });
      await expectSpendingWithin(jamie, 50_000);

      // A bid above what is left is refused with its reason and numbers.
      const tooMuch = await bid(jamie, LOT_CABIN, 66_000);
      expect(tooMuch.status).toBe(409);
      expect(await errorOf(tooMuch)).toMatchObject({ code: "over_bidding_power", details: { holdCents: 50_000 } });

      // The golden sentence: Chef's Table up to $380, Spa only under $120.
      const proposed = await say(jamie, GOLDEN_SENTENCE);
      const card = planCardOf(proposed);
      expect(card).toMatchObject({ state: "proposed", budgetCents: 50_000, autopilot: true });
      expect(card.items.map((item) => [item.lotNumber, item.maxCents])).toEqual([
        [LOT_CHEFS_TABLE, 38_000],
        [LOT_SPA_DAY, 12_000],
      ]);
      // A proposal costs nothing: no limit, no bid.
      expect((await lotNumbered(jamie.slug, LOT_SPA_DAY)).high_paddle_id).not.toBe(jamie.paddleId);

      // Start bidding: Glim's limits and its opening $90 on Spa Day, with the mandate stored and armed.
      const started = await startBidding(jamie, card.planId);
      expect(planCardOf(started).state).toBe("running");
      // design/22 #13 and #14: Start bidding's own card, then the opening bid's.
      expect(eventLines(started)).toEqual([expect.stringMatching(/ up to \$380, Spa Day up to \$120\.$/), "I bid $90 for you. I’ll go up to $120."]);
      expect(await lotNumbered(jamie.slug, LOT_SPA_DAY)).toMatchObject({ current_bid_cents: 9_000, high_paddle_id: jamie.paddleId, high_bid_source: "glim" });
      expect(await lotNumbered(jamie.slug, LOT_CHEFS_TABLE)).toMatchObject({ current_bid_cents: 32_000, high_paddle_id: jamie.paddleId });
      const [plan] = await rows<{ mandate: { budgetCents: number; lots: { lotNumber: number; role: string; capCents: number | null }[] } }>(
        "select mandate from glim_plans where paddle_id = $1 and status = 'active'",
        [jamie.paddleId],
      );
      expect(plan?.mandate.budgetCents).toBe(50_000);
      expect(plan?.mandate.lots.map((lot) => [lot.lotNumber, lot.role, lot.capCents])).toEqual([
        [LOT_CHEFS_TABLE, "plan", null],
        [LOT_SPA_DAY, "plan", 12_000],
        [LOT_WINE_TASTING, "backup", null],
      ]);
      expect(await expectSpendingWithin(jamie, 50_000)).toBe(50_000);

      // Kai raises his bidding power: the old authorization is voided as the new one lands.
      const kaiFirstHold = await holdWithPaypal(kai, 20_000);
      const kaiHold = await holdWithPaypal(kai, 40_000);
      const kaiReplaced = await holdOf(kaiFirstHold);
      expect(kaiReplaced.status).toBe("voided");
      expect(await nav(kai)).toMatchObject({ holdCents: 40_000 });
      const kaiLot = await lotNumbered(jamie.slug, LOT_KAI_BIDS_ON);
      const kaiBid = await jsonOf<{ bid: { amountCents: number } }>(await bid(kai, LOT_KAI_BIDS_ON, (kaiLot.current_bid_cents ?? 0) + 2_000));
      expect(kaiBid.bid.amountCents).toBeGreaterThan(0);

      // The first rival: $360, and Glim answers at Jamie's limit in the same transaction.
      const under = (await runDirectorUntil(await rivalJob(jamie.slug, "rival_under_limit"))).filter((report) => report.kind === "rival_under_limit");
      expect(under[0]?.result).toMatchObject({ outcome: "bid", paddleNumber: 88, amountCents: 36_000, answeredWithCents: [38_000] });
      await tickGlim(jamie);
      expect(eventLines(await chatView(jamie)).at(-1)).toBe("Someone bid $360. I raised to $380, your limit for this lot.");
      expect(await lotNumbered(jamie.slug, LOT_CHEFS_TABLE)).toMatchObject({ current_bid_cents: 38_000, high_paddle_id: jamie.paddleId, high_bid_source: "glim" });
      await expectSpendingWithin(jamie, 50_000);

      // The second rival: $400 passes the limit on Chef's Table.
      const over = (await runDirectorUntil(await rivalJob(jamie.slug, "rival_over_limit"))).filter((report) => report.kind === "rival_over_limit");
      expect(over[0]?.result).toMatchObject({ outcome: "bid", paddleNumber: 88, amountCents: 40_000, answeredWithCents: [] });

      // Nobody taps anything: the tick's tasks move the $380 to Wine Tasting with a $220 bid.
      await tickGlim(jamie);
      const moved = await chatView(jamie);
      expect(eventLines(moved).at(-1)).toBe("Someone bid $400, over your $380 limit.");
      const lastCard = moved.messages.at(-1)?.card;
      expect(lastCard).toMatchObject({ type: "autopilot", whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380." });
      expect(await lotNumbered(jamie.slug, LOT_WINE_TASTING)).toMatchObject({ current_bid_cents: 22_000, high_paddle_id: jamie.paddleId, high_bid_source: "glim" });
      expect(await lotNumbered(jamie.slug, LOT_CHEFS_TABLE)).toMatchObject({ current_bid_cents: 40_000, high_bid_source: "bot" });
      const limits = await rows<{ number: number; max_cents: number }>(
        `select l.number, bl.max_cents from bid_limits bl join lots l on l.id = bl.lot_id
         where bl.paddle_id = $1 and bl.owner = 'glim' and bl.active order by l.number`,
        [jamie.paddleId],
      );
      expect(limits).toEqual([
        { number: LOT_WINE_TASTING, max_cents: 38_000 },
        { number: LOT_SPA_DAY, max_cents: 12_000 },
      ]);
      expect(await expectSpendingWithin(jamie, 50_000)).toBe(50_000);

      // The tile and the nav read the move, for the guest who had the chat closed.
      const catalog = await getCatalogView({ slug: jamie.slug, paddleNumber: 142, category: null });
      const tile = (number: number) => catalog?.lots.find((lot) => lot.number === number);
      expect(tile(LOT_WINE_TASTING)?.viewerStatus).toBe("winning");
      expect(tile(LOT_CHEFS_TABLE)?.viewerStatus).toBe("outbid");
      expect(catalog?.viewer).toMatchObject({ holdCents: 50_000, winningCount: 2, outbidCount: 1 });
      // 10's feed shows the move with the bid it placed, not the new maximum (design/21 V4).
      const { feed } = await readPaddleGlim(pool, jamie.paddleId);
      expect(feed.find((entry) => entry.line.startsWith("I moved the $380 left to Wine Tasting."))).toMatchObject({
        label: "WINE TASTING",
        chip: { kind: "winning", amountCents: 22_000 },
      });

      // A simulated guest outbids Kai, so he ends the night with nothing to pay.
      const outbidCents = ((await lotNumbered(jamie.slug, LOT_KAI_BIDS_ON)).current_bid_cents ?? 0) + 5_000;
      const placed = await placeBid(await simulatedGuestWithRoom(jamie.slug, outbidCents), kaiLot.id, outbidCents, "bot", { pool });
      if (!placed.ok) throw new Error(`The outbid was refused: ${placed.refusal.reason}`);

      // Only the organizer closes bidding, and nothing bids after it.
      expect((await control(kai, "close-bidding")).status).toBe(403);
      expect(await jsonOf(await control(jamie, "close-bidding"))).toMatchObject({ eventClosed: true });
      const late = await bid(jamie, LOT_CABIN, 66_000);
      expect(late.status).toBe(409);
      expect(await errorOf(late)).toMatchObject({ code: "lot_closed" });
      await tickGlim(jamie);
      const closedView = await chatView(jamie);
      expect(eventLines(closedView)).toContain("Bidding closed. You won at $220.");
      // The plan card's "On my own" backup reads its outcome, like the plan's own lots.
      expect(planCardOf(closedView).onMyOwn?.backups.map((backup) => [backup.title, backup.statusText])).toEqual([["Wine Tasting", "Won at $220"]]);

      // Wine Tasting and Spa Day are Jamie's; a closed event gives Glim nothing more to do.
      expect(await lotNumbered(jamie.slug, LOT_WINE_TASTING)).toMatchObject({ status: "closed", winning_paddle_id: jamie.paddleId, winning_cents: 22_000 });
      expect(await lotNumbered(jamie.slug, LOT_SPA_DAY)).toMatchObject({ status: "closed", winning_paddle_id: jamie.paddleId, winning_cents: 9_000 });
      expect((await lotNumbered(jamie.slug, LOT_CHEFS_TABLE)).winning_paddle_id).not.toBe(jamie.paddleId);

      // The checks ask PayPal about each real hold, and every one passes.
      expect((await checksRoute(postJson(`/api/events/${kai.slug}/settlement/checks`, {}, { cookie: kai.cookie }), params({ slug: kai.slug }))).status).toBe(403);
      const { checks } = await jsonOf<{ checks: LedgerView["checks"] }>(
        await checksRoute(postJson(`/api/events/${jamie.slug}/settlement/checks`, {}, { cookie: jamie.cookie }), params({ slug: jamie.slug })),
      );
      expect(checks.passed).toBe(true);
      const before = await ledger(jamie);
      expect(before.phase).toBe("ready");
      expect(before.holds.real).toBe(2);
      expect(before.rows.find((row) => row.paddleNumber === 142)).toMatchObject({ toChargeCents: 31_000, toReleaseCents: 19_000 });
      // 21's V6 row: Glim's one move ($120 on Spa Day, the $380 moved to Wine Tasting) is $500 in all,
      // inside "Never past $500 in all", so it reads "Glim stayed inside every guest's rules".
      expect(before.glim).toMatchObject({ decisions: 1, decisionsOutsideRules: 0 });

      // Charge the winners.
      const charged = await chargeRoute(postJson(`/api/events/${jamie.slug}/settlement`, {}, { cookie: jamie.cookie }), params({ slug: jamie.slug }));
      expect(charged.status).toBe(200);
      await settlementRunnerIdle();

      const after = await ledger(jamie);
      expect(after.phase).toBe("charged");
      expect(after.settlement?.status).toBe("done");
      expect(after.event.status).toBe("settled");

      // Jamie: the won total captured with final_capture, the other $190 released.
      const held = await holdOf(jamieHold);
      expect(held.status).toBe("captured");
      const [item] = await rows<{ action: string; status: string; amount_cents: number; released_cents: number; paypal_capture_id: string | null }>(
        "select action, status, amount_cents, released_cents, paypal_capture_id from settlement_items where paddle_id = $1",
        [jamie.paddleId],
      );
      expect(item).toMatchObject({ action: "capture", status: "succeeded", amount_cents: 31_000, released_cents: 19_000 });
      expect(item?.paypal_capture_id).toBeTruthy();
      expect(item?.amount_cents).toBeLessThanOrEqual(50_000);
      const readBack = await getSimulatedPayments().getAuthorization(held.current_authorization_id ?? "");
      expect(readBack.status).toBe("CAPTURED");

      // Kai: voided, on the original id, with nothing charged. His raise's old hold is voided too.
      const kaiFinal = await holdOf(kaiHold);
      expect(kaiFinal.status).toBe("voided");
      expect((await getSimulatedPayments().getAuthorization(kaiFinal.original_authorization_id ?? "")).status).toBe("VOIDED");
      expect((await getSimulatedPayments().getAuthorization(kaiReplaced.original_authorization_id ?? "")).status).toBe("VOIDED");
      const [kaiItem] = await rows<{ action: string; status: string; amount_cents: number }>(
        "select action, status, amount_cents from settlement_items where paddle_id = $1",
        [kai.paddleId],
      );
      expect(kaiItem).toEqual({ action: "void", status: "succeeded", amount_cents: 0 });

      // The simulated guests settle in the database, and PayPal hears of none of them.
      const simulated = await rows<{ action: string; status: string; with_capture: number; n: number }>(
        `select si.action, si.status, count(si.paypal_capture_id)::int as with_capture, count(*)::int as n
         from settlement_items si join paddles pd on pd.id = si.paddle_id
         where pd.is_simulated group by si.action, si.status`,
      );
      expect(simulated.map(({ action, status, with_capture }) => ({ action, status, with_capture }))).toEqual([{ action: "simulate", status: "succeeded", with_capture: 0 }]);
      const [unsettled] = await rows<{ n: number }>("select count(*)::int as n from settlement_items where status <> 'succeeded'");
      expect(unsettled?.n).toBe(0);

      // The receipt is a snapshot taken at the capture.
      const [receipt] = await rows<{ paid_cents: number; released_cents: number; hold_cents: number; paypal_capture_id: string | null; lines: ReceiptLine[]; glim_recap: ReceiptGlimRecap }>(
        "select paid_cents, released_cents, hold_cents, paypal_capture_id, lines, glim_recap from receipts where paddle_id = $1",
        [jamie.paddleId],
      );
      expect(receipt).toMatchObject({ paid_cents: 31_000, released_cents: 19_000, hold_cents: 50_000, paypal_capture_id: item?.paypal_capture_id });
      expect(receipt?.lines.map((line) => [line.kind, line.lotNumber, line.kind === "won" ? line.paidCents : null, line.kind === "won" ? line.bidBy : null])).toEqual([
        ["won", LOT_WINE_TASTING, 22_000, "glim"],
        ["won", LOT_SPA_DAY, 9_000, "glim"],
        ["not_won", LOT_CHEFS_TABLE, null, null],
      ]);
      expect(receipt?.glim_recap).toMatchObject({ allWithinLimits: true });
      expect(await rows("select id from receipts where paddle_id = $1", [kai.paddleId])).toEqual([]);

      // A second press charges nobody twice.
      expect((await chargeRoute(postJson(`/api/events/${jamie.slug}/settlement`, {}, { cookie: jamie.cookie }), params({ slug: jamie.slug }))).status).toBe(200);
      await settlementRunnerIdle();
      expect(await rows("select paypal_capture_id from settlement_items where paddle_id = $1", [jamie.paddleId])).toEqual([{ paypal_capture_id: item?.paypal_capture_id }]);

      // Every step reached the browser: the live stream and the poll read the same rows, Jamie's alone.
      await jamieStream.waitFor((frame) => frame.event === "hold" && (frame.data as { payload: { status?: string } }).payload.status === "captured", STREAM_WAIT_MS);
      const poll = await jsonOf<StreamPollResponse>(
        await pollRoute(withCookie(jamie.cookie, `/api/stream/poll?slug=${jamie.slug}&after=${position}`), undefined),
      );
      const seen = new Set(poll.rows.map((row) => row.type));
      expect(seen).toEqual(new Set(["hold", "bid", "glim", "lot_closed", "event_status", "settlement"]));
      // Jamie organizes this gala, so she alone also sees other paddles' rows for the ledger.
      const othersRows = poll.rows.filter((row) => row.paddleId !== null && row.paddleId !== jamie.paddleId);
      expect(new Set(othersRows.map((row) => row.type))).toEqual(new Set(ORGANIZER_STREAM_TYPES));
      expect(kaiStream.rows.filter((row) => row.paddleId !== null).every((row) => row.paddleId === kai.paddleId)).toBe(true);
    } finally {
      await jamieStream.close();
      await kaiStream.close();
    }
  }, 60_000);

  it("never spends over $500 with the bots pushing Wine Tasting to their ceiling", async () => {
    const { jamie, holdId, card } = await upToStartBidding();
    await startBidding(jamie, card.planId);
    await theRivalsAndGlimsMove(jamie);
    expect(await lotNumbered(jamie.slug, LOT_WINE_TASTING)).toMatchObject({ current_bid_cents: 22_000, high_paddle_id: jamie.paddleId });

    // Minute by minute up to just before Wine Tasting closes, as the tick would.
    const [event] = await rows<{ closes_at: Date; demo_expires_at: Date }>(
      "select l.closes_at, e.demo_expires_at from lots l join events e on e.id = l.event_id where e.slug = $1 and l.number = $2",
      [jamie.slug, LOT_WINE_TASTING],
    );
    if (!event) throw new Error("No Wine Tasting");
    const wineEnds = event.closes_at.getTime() - 6_000;
    const startedAt = await rivalJob(jamie.slug, "rival_over_limit");
    for (let at = startedAt.getTime(); at < wineEnds; at += 60_000) {
      await runDirectorUntil(new Date(at));
      await expectSpendingWithin(jamie, 50_000);
    }
    await runDirectorUntil(new Date(wineEnds));
    await tickGlim(jamie);
    await expectSpendingWithin(jamie, 50_000);

    const wine = await lotNumbered(jamie.slug, LOT_WINE_TASTING);
    expect(wine.current_bid_cents).toBeGreaterThan(22_000);
    expect(wine.current_bid_cents).toBeLessThanOrEqual(38_000);
    expect(wine.high_paddle_id).toBe(jamie.paddleId);
    const botBids = await rows<{ amount_cents: number }>(
      "select b.amount_cents from bids b where b.lot_id = $1 and b.source = 'bot'",
      [wine.id],
    );
    expect(botBids.every((row) => row.amount_cents <= 37_000)).toBe(true);

    await jsonOf(await control(jamie, "close-bidding"));
    await jsonOf(await chargeRoute(postJson(`/api/events/${jamie.slug}/settlement`, {}, { cookie: jamie.cookie }), params({ slug: jamie.slug })));
    await settlementRunnerIdle();

    const won = await rows<{ winning_cents: number }>(
      "select l.winning_cents from lots l join events e on e.id = l.event_id where e.slug = $1 and l.winning_paddle_id = $2",
      [jamie.slug, jamie.paddleId],
    );
    const wonTotal = won.reduce((sum, row) => sum + row.winning_cents, 0);
    expect(wonTotal).toBeGreaterThan(31_000);
    expect(wonTotal).toBeLessThanOrEqual(50_000);
    expect(await rows("select amount_cents, status from settlement_items where hold_id = $1", [holdId])).toEqual([{ amount_cents: wonTotal, status: "succeeded" }]);
    expect((await holdOf(holdId)).status).toBe("captured");
  }, 60_000);

  it("stands still with the autopilot off (GLIM_AUTOPILOT=off): Glim only raises to the card's limits", async () => {
    armed.on = false;
    const { jamie, holdId, card } = await upToStartBidding();
    expect(card.autopilot).toBe(false);
    await startBidding(jamie, card.planId);
    expect(await rows("select mandate from glim_plans where paddle_id = $1 and status = 'active'", [jamie.paddleId])).toEqual([{ mandate: null }]);
    await theRivalsAndGlimsMove(jamie);

    // The rival still has its $400, and nothing moved: no armed paddle, no run, no card.
    expect(await lotNumbered(jamie.slug, LOT_CHEFS_TABLE)).toMatchObject({ current_bid_cents: 40_000, high_bid_source: "bot" });
    expect((await lotNumbered(jamie.slug, LOT_WINE_TASTING)).high_paddle_id).not.toBe(jamie.paddleId);
    expect(await rows("select paddle_id from glim_autopilot where paddle_id = $1", [jamie.paddleId])).toEqual([]);
    const view = await chatView(jamie);
    expect(eventLines(view).at(-1)).toBe("Someone bid $400, over your $380 limit.");
    expect(view.messages.some((message) => message.card?.type === "autopilot")).toBe(false);

    // Close and charge: only Spa Day was won, and the hold covers it.
    await jsonOf(await control(jamie, "close-bidding"));
    await jsonOf(await chargeRoute(postJson(`/api/events/${jamie.slug}/settlement`, {}, { cookie: jamie.cookie }), params({ slug: jamie.slug })));
    await settlementRunnerIdle();
    expect(await rows("select amount_cents, released_cents, status from settlement_items where hold_id = $1", [holdId])).toEqual([
      { amount_cents: 9_000, released_cents: 41_000, status: "succeeded" },
    ]);
    expect((await holdOf(holdId)).status).toBe("captured");
  }, 60_000);
});

/** A simulated guest with room for a bid of this size. */
async function simulatedGuestWithRoom(slug: string, amountCents: number): Promise<string> {
  const paddles = await rows<{ id: string }>(
    "select pd.id from paddles pd join events e on e.id = pd.event_id where e.slug = $1 and pd.is_simulated order by pd.number",
    [slug],
  );
  const power = await getBiddingPower(paddles.map((paddle) => paddle.id), pool);
  const paddle = paddles.find(({ id }) => (power.get(id)?.availableCents ?? 0) >= amountCents);
  if (!paddle) throw new Error("No simulated guest has that much room");
  return paddle.id;
}
