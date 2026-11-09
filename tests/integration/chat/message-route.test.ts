/**
 * POST /api/glim/[slug]/messages on Postgres with recorded replies: the golden sentence gives the
 * approved card, Start bidding places the opening bid, a refusal offers a raise, the caps hold, and two
 * messages at once take turns. Replies come from tests/fixtures/glim/recorded, so no key is needed.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { APIConnectionError } from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquireTurnLock } from "@/server/chat/lock";
import { runChatTurn } from "@/server/chat/turn";
import { getBiddingPower } from "@/server/engine";
import { CAP_REACHED_LINE, ERROR_LINE, FALLBACK_LINE, TOO_LONG_LINE } from "@/server/glim/copy";
import { syntheticMessage } from "@/server/glim/recorded";
import type { GlimModel, GlimModelRequest } from "@/server/glim/client";
import { tokensToday } from "@/server/plans/usage";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { modelReply, scriptedModel, textBlock, toolUseBlock } from "../../unit/glim/helpers";
import { bid, forbiddenModel, rows } from "../plans/support";

import { clickStartBidding, createChatGala, eventLines, lastPlanCard, readView, sendMessage } from "./support";

let scripted: GlimModel | null = null;

// The routes call getGlimModel(): recorded replies by default, or a test's own script.
vi.mock("@/server/glim/client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/server/glim/client")>();
  return { ...original, getGlimModel: () => scripted ?? original.getGlimModel() };
});

const database = getTestDatabase();
const { pool } = database;

afterEach(() => {
  scripted = null;
});

const count = async (text: string, values: unknown[]) => (await rows<{ n: number }>(pool, text, values))[0]?.n ?? 0;

describe("the golden sentence", () => {
  it("gives the $380 / $120 card, stored and streamed", async () => {
    const gala = await createChatGala(pool);
    const answer = await sendMessage(gala, GOLDEN_SENTENCE);

    expect(answer.status).toBe(200);
    expect(answer.error).toBeNull();
    const card = lastPlanCard(answer.view);
    expect(card.state).toBe("proposed");
    expect(card.budgetCents).toBe(50_000);
    expect(card.items.map((item) => [item.lotNumber, item.priority, item.maxCents, item.statusText, item.sharePercent])).toEqual([
      [7, 1, 38_000, "Winning at $320", 76],
      [12, 2, 12_000, "Current bid $85", 24],
    ]);
    // V1 is approved, so the shipped card carries the "ON MY OWN" block and arms the autopilot.
    expect(card.autopilot).toBe(true);
    expect(card.onMyOwn).toEqual({
      eyebrow: "ON MY OWN",
      body: "If a lot gets away, I’ll move its money to your other lots, and tell you why.",
      backups: [],
      rules: "Never past $500 in all, and Spa Day up to $120.",
    });
    expect(answer.frames.at(-1)?.type).toBe("done");
    expect(answer.view?.messages.map((message) => message.role)).toEqual(["guest", "glim"]);
    expect(answer.view?.messages[0]?.text).toBe(GOLDEN_SENTENCE);
    expect(answer.view?.greeting).toBe("Hi Jamie. What’s your budget tonight?");
    // design/22 #1: not on duty until Start bidding.
    expect(answer.view?.status).toEqual({ tone: "off", mark: "off", text: "Not bidding yet · $500 held with PayPal" });

    // Stored as a proposal; nothing bid, nothing armed.
    expect(await rows(pool, "select status, budget_cents, mandate from glim_plans where paddle_id = $1", [gala.jamie])).toEqual([
      { status: "proposed", budget_cents: 50_000, mandate: null },
    ]);
    expect(await count("select count(*)::int as n from bid_limits where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("appends what the model saw and said to the transcript, verbatim and in order", async () => {
    const gala = await createChatGala(pool);
    await sendMessage(gala, GOLDEN_SENTENCE);
    const stored = await rows<{ position: number; message: { role: string; content: unknown }; chat_message_id: string | null }>(
      pool,
      "select position, message, chat_message_id from glim_transcript where paddle_id = $1 order by position",
      [gala.jamie],
    );
    expect(stored.map((row) => [row.position, row.message.role])).toEqual([
      [0, "user"],
      [1, "system"],
      [2, "assistant"],
      [3, "user"],
    ]);
    expect(stored[0]?.message.content).toBe(GOLDEN_SENTENCE);
    expect(stored[1]?.message.content).toEqual(expect.stringContaining("STATE SNAPSHOT"));
    expect(stored[1]?.message.content).toEqual(expect.not.stringContaining("Glim's autopilot is off for this guest"));
    const toolUse = (stored[2]?.message.content as { type: string; id: string; name: string }[])[0];
    expect(toolUse).toMatchObject({ type: "tool_use", name: "propose_plan" });
    expect(stored[3]?.message.content).toEqual([expect.objectContaining({ type: "tool_result", tool_use_id: toolUse?.id })]);
    const messages = await rows<{ id: string; role: string }>(pool, "select id, role from chat_messages where paddle_id = $1", [gala.jamie]);
    const guestId = messages.find((row) => row.role === "guest")?.id;
    const glimId = messages.find((row) => row.role === "glim")?.id;
    expect(stored.map((row) => row.chat_message_id)).toEqual([guestId, guestId, glimId, guestId]);
  });

  it("continues the same conversation on the next message", async () => {
    const gala = await createChatGala(pool);
    await sendMessage(gala, GOLDEN_SENTENCE);
    const { model, requests } = scriptedModel(() => modelReply([textBlock("You’re winning Chef’s Table at $320.")]));
    scripted = model;
    const answer = await sendMessage(gala, "How am I doing?");
    expect(answer.streamed).toBe("You’re winning Chef’s Table at $320.");
    expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "system", "assistant", "user", "user", "system"]);
    expect(requests[0]?.messages.at(-2)?.content).toBe("How am I doing?");
  });

  it("keeps the guest's words as the card's source, and supersedes an older card still waiting", async () => {
    const gala = await createChatGala(pool);
    const first = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    const second = await sendMessage(gala, GOLDEN_SENTENCE);
    const newest = lastPlanCard(second.view);
    expect(newest.planId).not.toBe(first.planId);
    const cards = second.view?.messages.flatMap((message) => (message.card?.type === "plan" ? [message.card] : [])) ?? [];
    expect(cards.map((card) => card.state)).toEqual(["over", "proposed"]);
    expect(cards[0]?.stateLine).toMatch(/^Replaced at \d+:\d\d [AP]M$/);
    expect((await clickStartBidding(gala, first.planId)).error?.code).toBe("plan_not_proposed");
    expect((await clickStartBidding(gala, newest.planId)).status).toBe(200);
  });
});

describe("what other tabs hear", () => {
  it("a row on the paddle's channel for each stored reply, naming its message", async () => {
    const gala = await createChatGala(pool);
    await sendMessage(gala, GOLDEN_SENTENCE);
    await sendMessage(gala, "Can you also get me the cabin?");
    const channel = await rows<{ paddle_id: string; message_id: string; role: string }>(
      pool,
      `select el.paddle_id, el.payload->>'chatMessageId' as message_id, m.role
       from event_log el join chat_messages m on m.id = (el.payload->>'chatMessageId')::uuid
       where el.paddle_id = $1 and el.type = 'glim' and el.payload->>'kind' = 'chat_card' order by el.id`,
      [gala.jamie],
    );
    expect(channel.map((row) => row.role)).toEqual(["glim", "glim"]);
  });
});

describe("Start bidding", () => {
  it("places $90 on Spa Day, reserves the limits and tells the guest", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    const clicked = await clickStartBidding(gala, card.planId);
    expect(clicked.status).toBe(200);

    const bids = await rows(pool, "select lot_id, amount_cents, source from bids where paddle_id = $1 and source = 'glim'", [gala.jamie]);
    expect(bids).toEqual([{ lot_id: gala.lots.spa, amount_cents: 9_000, source: "glim" }]);
    const limits = await rows(pool, "select lot_id, max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents", [gala.jamie]);
    expect(limits).toEqual([
      { lot_id: gala.lots.spa, max_cents: 12_000 },
      { lot_id: gala.lots.chef, max_cents: 38_000 },
    ]);
    const power = (await getBiddingPower([gala.jamie], pool)).get(gala.jamie);
    expect(power).toMatchObject({ holdCents: 50_000, committedCents: 50_000 });

    // design/22 #13, then #14: Start bidding's own card, then the opening bid's.
    expect(eventLines(clicked.view)).toEqual(["Chef’s Table up to $380, Spa Day up to $120.", "I bid $90 for you. I’ll go up to $120."]);
    expect(clicked.view?.messages.at(-2)?.card).toMatchObject({ type: "event", eyebrow: expect.stringMatching(/^\d+:\d\d [AP]M · PLAN STARTED$/) });
    const started = lastPlanCard(clicked.view);
    expect(started.state).toBe("running");
    expect(started.stateLine).toMatch(/^Started at \d+:\d\d [AP]M$/);
    expect(started.items.map((item) => item.statusText)).toEqual(["Winning at $320", "Winning at $90"]);
    expect(clicked.view?.quickReplies.map((reply) => reply.label)).toEqual(["Raise my budget", "Skip the spa", "How am I doing?"]);
  });

  it("does not arm the autopilot with it off (GLIM_AUTOPILOT=off): no mandate, nothing to wake it", async () => {
    const gala = await createChatGala(pool);
    await pool.query("insert into favorites (paddle_id, lot_id) values ($1, $2)", [gala.jamie, gala.lots.wine]);
    const turn = await runChatTurn({ paddleId: gala.jamie, eventId: gala.eventId, text: GOLDEN_SENTENCE, autopilot: false, database });
    if (!turn.planId) throw new Error("no plan");
    expect(lastPlanCard(await readView(gala)).onMyOwn).toBeNull();
    await clickStartBidding(gala, turn.planId);

    expect(await rows(pool, "select status, mandate from glim_plans where paddle_id = $1", [gala.jamie])).toEqual([{ status: "active", mandate: null }]);
    expect(await count("select count(*)::int as n from glim_autopilot where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("stores the mandate and arms the autopilot through the routes, as shipped", async () => {
    const gala = await createChatGala(pool);
    await pool.query("insert into favorites (paddle_id, lot_id) values ($1, $2)", [gala.jamie, gala.lots.wine]);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    expect(card.autopilot).toBe(true);
    // V1 (design/21 #1): the hearted backup, and the rules Start bidding agrees to.
    expect(card.onMyOwn).toEqual({
      eyebrow: "ON MY OWN",
      body: "If a lot gets away, I’ll move its money to your other lots or this backup, and tell you why.",
      backups: [{ lotId: gala.lots.wine, title: "Wine Tasting", sourceLabel: "You hearted it", statusText: "Current bid $210" }],
      rules: "Never past $500 in all, and Spa Day up to $120.",
    });
    await clickStartBidding(gala, card.planId);

    const [plan] = await rows<{ mandate: { budgetCents: number; lots: { lotId: string; role: string; capCents: number | null }[] } }>(
      pool,
      "select mandate from glim_plans where paddle_id = $1 and status = 'active'",
      [gala.jamie],
    );
    expect(plan?.mandate.budgetCents).toBe(50_000);
    expect(plan?.mandate.lots.map((lot) => [lot.lotId, lot.role, lot.capCents])).toEqual([
      [gala.lots.chef, "plan", null],
      [gala.lots.spa, "plan", 12_000],
      [gala.lots.wine, "backup", null],
    ]);
    expect(await count("select count(*)::int as n from glim_autopilot where paddle_id = $1", [gala.jamie])).toBe(1);
    // And Glim is no longer told it can't.
    const snapshots = await rows<{ content: string }>(
      pool,
      "select message->>'content' as content from glim_transcript where paddle_id = $1 and message->>'role' = 'system'",
      [gala.jamie],
    );
    expect(snapshots.map((row) => row.content.includes("Glim's autopilot is off"))).toEqual([false]);
  });

  it("explains a refusal in Glim's words and changes nothing", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    // Someone outbids the card's $380 for Chef's Table before Jamie clicks.
    await pool.query("update lots set current_bid_cents = 40000, high_paddle_id = $2 where id = $1", [gala.lots.chef, gala.rival]);
    const clicked = await clickStartBidding(gala, card.planId);
    expect(clicked.status).toBe(409);
    expect(clicked.error).toMatchObject({ code: "below_minimum", message: "Someone bid while you were reading, so this plan no longer fits. Tell me what you’d like now." });
    expect(await count("select count(*)::int as n from bid_limits where paddle_id = $1", [gala.jamie])).toBe(0);
    expect(lastPlanCard(await readView(gala)).state).toBe("proposed");
  });

  it("refuses a plan id that is not a uuid, or another guest's", async () => {
    const gala = await createChatGala(pool);
    expect((await clickStartBidding(gala, "not-a-plan")).error?.code).toBe("plan_not_found");
    expect((await clickStartBidding(gala, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});

describe("refusals", () => {
  it("offers a raise when the lot is past the bidding power, opening 09 in raise mode", async () => {
    const gala = await createChatGala(pool);
    const answer = await sendMessage(gala, "Can you also get me the cabin?");
    expect(answer.error).toBeNull();
    expect(answer.streamed).toBe("The Cabin Stay’s next bid is $660, more than your bidding power has room for. Want to raise it?");
    const message = answer.view?.messages.at(-1);
    expect(message?.text).toBe(answer.streamed);
    // design/22 #5: the lot and its bid, what is left, 07's lime button and its note.
    expect(message?.card).toEqual({
      type: "hold",
      amountCents: 100_000,
      currentHoldCents: 50_000,
      lot: { label: "Cabin Stay · Current bid", amountCents: 64_000 },
      left: { leftCents: 18_000, holdCents: 50_000 },
      label: "Raise bidding power",
      note: "You’ll approve another hold in a PayPal window.",
      href: `/e/${gala.slug}/power?amount=1000`,
    });
    expect(answer.view?.quickReplies.map((reply) => reply.label)).toEqual(["What else fits?", "How am I doing?"]);
    expect(await count("select count(*)::int as n from glim_plans where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("ends the offer with the bidding, or once the bidding power reaches it, and keeps the words", async () => {
    const gala = await createChatGala(pool);
    const offered = await sendMessage(gala, "Can you also get me the cabin?");
    expect(offered.view?.messages.at(-1)?.card?.type).toBe("hold");

    await pool.query("update holds set amount_cents = 100000 where paddle_id = $1 and status = 'authorized'", [gala.jamie]);
    const raised = await readView(gala);
    expect(raised.messages.at(-1)?.text).toBe(offered.streamed);
    expect(raised.messages.at(-1)?.card).toBeNull();

    await pool.query("update holds set amount_cents = 50000 where paddle_id = $1 and status = 'authorized'", [gala.jamie]);
    expect((await readView(gala)).messages.at(-1)?.card?.type).toBe("hold");
    await pool.query("update events set status = 'closed' where id = $1", [gala.eventId]);
    expect((await readView(gala)).messages.at(-1)?.card).toBeNull();
  });

  it("logs every rejected proposal in glim_actions, and shows the plan the retry made", async () => {
    const gala = await createChatGala(pool);
    const answer = await sendMessage(gala, "$600. Get me the chef's dinner, and the spa if it stays under $120.");
    const card = lastPlanCard(answer.view);
    expect(card.budgetCents).toBe(50_000);
    const [plan] = await rows<{ id: string; proposal: { namedBudgetCents: number } }>(pool, "select id, proposal from glim_plans where paddle_id = $1", [gala.jamie]);
    expect(plan?.proposal.namedBudgetCents).toBe(60_000);
    const rejected = await rows(
      pool,
      "select kind, decision, reject_reason, plan_id, hold_cents_at_time from glim_actions where paddle_id = $1 and kind = 'proposal_rejected'",
      [gala.jamie],
    );
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]).toMatchObject({ decision: "rejected", reject_reason: "budget_over_available", plan_id: plan?.id, hold_cents_at_time: 50_000 });
  });
});

describe("07's other recorded replies", () => {
  it("answers How am I doing? on the golden plan with the model's own words", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    const answer = await sendMessage(gala, "How am I doing?");
    expect(answer.streamed).toContain("Chef's Table at $320 with a maximum of $380, and Spa Day at $90 with a maximum of $120");
    expect(answer.view?.messages.at(-1)?.text).toBe(answer.streamed);
    expect(await rows(pool, "select error from chat_messages where paddle_id = $1 and role = 'glim' order by created_at desc limit 1", [gala.jamie])).toEqual([{ error: null }]);
  });

  it("gives way to the guard's line from live numbers once its figures are out of date", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    const answer = await sendMessage(gala, "How am I doing?");
    expect(answer.streamed).toBe("You have $30 of your $500 bidding power left.");
    expect(answer.view?.messages.at(-1)?.text).toBe(answer.streamed);
  });

  it("turns Edit's words into a change card, which Start bidding applies", async () => {
    const gala = await createChatGala(pool);
    const started = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, started.planId);
    const answer = await sendMessage(gala, "Change my plan: drop the spa.");
    const change = lastPlanCard(answer.view);
    expect(change.state).toBe("proposed");
    expect(change.items.map((item) => [item.lotNumber, item.maxCents])).toEqual([[7, 38_000]]);
    expect((await clickStartBidding(gala, change.planId)).status).toBe(200);
    const limits = await rows(pool, "select lot_id, max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active", [gala.jamie]);
    expect(limits).toEqual([{ lot_id: gala.lots.chef, max_cents: 38_000 }]);
    // The bid already placed stands.
    expect(await rows(pool, "select amount_cents from bids where lot_id = $1 and paddle_id = $2", [gala.lots.spa, gala.jamie])).toEqual([{ amount_cents: 9_000 }]);
  });
});

describe("the error fallback", () => {
  const failing = (): GlimModel => ({
    mode: "live",
    async respond(): Promise<never> {
      throw new APIConnectionError({ message: "down" });
    },
  });

  it("answers design/22 #4's line, stores the exchange and keeps the transcript clean", async () => {
    const gala = await createChatGala(pool);
    scripted = failing();
    const answer = await sendMessage(gala, GOLDEN_SENTENCE);
    expect(answer.error).toBeNull();
    expect(answer.streamed).toBe(ERROR_LINE);
    expect(answer.view?.messages.map((message) => message.text)).toEqual([GOLDEN_SENTENCE, ERROR_LINE]);
    // Try again sends the same words; See the lots goes back to 08.
    expect(answer.view?.quickReplies).toEqual([
      { kind: "ask", label: "Try again", text: GOLDEN_SENTENCE },
      { kind: "link", label: "See the lots", href: `/e/${gala.slug}` },
    ]);
    expect(await rows(pool, "select error from chat_messages where paddle_id = $1 and role = 'glim'", [gala.jamie])).toEqual([{ error: "network_error" }]);
    expect(await count("select count(*)::int as n from glim_transcript where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("does the same on a refusal, counting the tokens it cost", async () => {
    const gala = await createChatGala(pool);
    scripted = scriptedModel(() => syntheticMessage([], "refusal", { usage: { input_tokens: 100, output_tokens: 5 } })).model;
    const answer = await sendMessage(gala, GOLDEN_SENTENCE);
    expect(answer.streamed).toBe(ERROR_LINE);
    expect(await rows(pool, "select error, tokens_used from chat_messages where paddle_id = $1 and role = 'glim'", [gala.jamie])).toEqual([
      { error: "refusal", tokens_used: 105 },
    ]);
  });

  it("says something even when the model says nothing", async () => {
    const gala = await createChatGala(pool);
    scripted = scriptedModel(() => modelReply([])).model;
    const answer = await sendMessage(gala, "Hello?");
    expect(answer.view?.messages.at(-1)?.text).toBe(FALLBACK_LINE);
  });
});

describe("the caps", () => {
  const seedGuestMessages = async (paddleId: string, count: number) =>
    pool.query("insert into chat_messages (paddle_id, role, text) select $1, 'guest', 'x' from generate_series(1, $2)", [paddleId, count]);

  it("stops at 40 messages per paddle, without calling the model or storing the message", async () => {
    const gala = await createChatGala(pool);
    await seedGuestMessages(gala.jamie, 39);
    scripted = scriptedModel(() => modelReply([textBlock("Fine.")])).model;
    expect((await sendMessage(gala, "One more")).streamed).toBe("Fine.");

    const forbidden = forbiddenModel();
    scripted = forbidden;
    const answer = await sendMessage(gala, "And another");
    expect(answer.streamed).toBe(CAP_REACHED_LINE);
    expect(answer.unsaved).toEqual({ guestText: "And another", reply: CAP_REACHED_LINE });
    expect(forbidden.calls).toBe(0);
    expect(await count("select count(*)::int as n from chat_messages where paddle_id = $1 and role = 'guest'", [gala.jamie])).toBe(40);
  });

  it("stops at 300 messages per event, across its guests", async () => {
    const gala = await createChatGala(pool);
    await seedGuestMessages(gala.rival, 299);
    await seedGuestMessages(gala.other, 1);
    const forbidden = forbiddenModel();
    scripted = forbidden;
    expect((await sendMessage(gala, GOLDEN_SENTENCE)).streamed).toBe(CAP_REACHED_LINE);
    expect(forbidden.calls).toBe(0);
  });

  it("stops at the daily token budget, read through tokensToday, which counts plan cards too", async () => {
    const gala = await createChatGala(pool);
    const usage = { input_tokens: 700, output_tokens: 300 };
    scripted = scriptedModel(() =>
      syntheticMessage(
        [toolUseBlock("propose_plan", { budget_dollars: 500, items: [{ lot_number: 7, priority: 1, cap_dollars: null }], backup_lot_numbers: [], excluded_lot_numbers: [] })],
        "tool_use",
        { usage },
      ),
    ).model;
    const { rows: now } = await pool.query<{ now: Date }>("select now() as now");
    const spent = await tokensToday(pool, now[0]?.now ?? new Date());
    const budget = spent + 1_500;
    const turn = () => runChatTurn({ paddleId: gala.jamie, eventId: gala.eventId, text: "Spend it on the dinner", dailyTokenBudget: budget, database });

    expect((await turn()).result.card?.type).toBe("plan");
    expect(await tokensToday(pool, now[0]?.now ?? new Date())).toBe(spent + 1_000);
    expect(await rows(pool, "select tokens_used, input_tokens, output_tokens, model from chat_messages where paddle_id = $1 and role = 'glim'", [gala.jamie])).toEqual([
      { tokens_used: 1_000, input_tokens: 700, output_tokens: 300, model: expect.any(String) },
    ]);
    expect((await turn()).result.card?.type).toBe("plan");
    const capped = await turn();
    expect(capped.reply).toBe(CAP_REACHED_LINE);
    expect(capped.stored).toBe(false);
    expect(capped.result.error).toBe("daily_tokens");
  });

  it("answers an empty or overlong message without a model call, and keeps neither", async () => {
    const gala = await createChatGala(pool);
    const forbidden = forbiddenModel();
    scripted = forbidden;
    expect((await sendMessage(gala, "   ")).unsaved?.reply).toBe("Tell me your budget and the lots you like, and I’ll suggest a plan.");
    expect((await sendMessage(gala, "x".repeat(1_001))).streamed).toBe(TOO_LONG_LINE);
    expect(forbidden.calls).toBe(0);
    expect(await count("select count(*)::int as n from chat_messages where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("turns a burst away at the route's own brake", async () => {
    const gala = await createChatGala(pool);
    await pool.query(
      "insert into rate_limits (key, window_start, count) values ($1, to_timestamp(floor(extract(epoch from now()) / 60) * 60), 30)",
      [`glim_messages:${gala.jamie}`],
    );
    const answer = await sendMessage(gala, GOLDEN_SENTENCE);
    expect(answer.status).toBe(429);
    expect(answer.error?.code).toBe("rate_limited");
  });
});

describe("one turn at a time", () => {
  it("serializes two messages of one paddle: the second runs on what the first left", async () => {
    const gala = await createChatGala(pool);
    let running = 0;
    let most = 0;
    const seen: GlimModelRequest[] = [];
    scripted = scriptedModel(async (request) => {
      running += 1;
      most = Math.max(most, running);
      seen.push(request);
      await sleep(150);
      running -= 1;
      return modelReply([textBlock(`Answer to: ${request.guestText}`)]);
    }).model;

    const [first, second] = await Promise.all([sendMessage(gala, "First question"), sendMessage(gala, "Second question")]);

    expect(most).toBe(1);
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    // Whichever got the lock first, the other's request carries its whole turn.
    const [earlier, later] = seen;
    expect(earlier?.messages).toHaveLength(2);
    expect(later?.messages).toHaveLength(5);
    expect(later?.messages[2]?.role).toBe("assistant");
    const positions = await rows<{ position: number }>(pool, "select position from glim_transcript where paddle_id = $1 order by position", [gala.jamie]);
    expect(positions.map((row) => row.position)).toEqual([0, 1, 2, 3, 4, 5]);
    const view = await readView(gala);
    expect(view.messages.map((message) => message.text)).toEqual([
      earlier?.guestText,
      `Answer to: ${earlier?.guestText}`,
      later?.guestText,
      `Answer to: ${later?.guestText}`,
    ]);
  });

  it("does not make two paddles wait for each other", async () => {
    const gala = await createChatGala(pool);
    const held = await acquireTurnLock(gala.jamie);
    const other = await acquireTurnLock(gala.rival, { waitMs: 500 });
    await other.release();
    await held.release();
  });

  it("answers 409 glim_busy when the wait runs out, then the turn is free again", async () => {
    const gala = await createChatGala(pool);
    const held = await acquireTurnLock(gala.jamie);
    await expect(acquireTurnLock(gala.jamie, { waitMs: 100 })).rejects.toMatchObject({ status: 409, code: "glim_busy" });
    await held.release();
    const again = await acquireTurnLock(gala.jamie, { waitMs: 2_000 });
    await again.release();
  });

  it("answers a paddle's third message at once, and takes one again when a place is free", async () => {
    const gala = await createChatGala(pool);
    const first = await acquireTurnLock(gala.jamie);
    const second = acquireTurnLock(gala.jamie, { waitMs: 10_000 });

    const asked = Date.now();
    await expect(acquireTurnLock(gala.jamie, { waitMs: 10_000 })).rejects.toMatchObject({ status: 409, code: "glim_busy" });
    expect(Date.now() - asked).toBeLessThan(1_000);

    await first.release();
    const secondHeld = await second;
    const third = acquireTurnLock(gala.jamie, { waitMs: 10_000 });
    await secondHeld.release();
    await (await third).release();
  });

  it("gives a place back when taking the lock fails", async () => {
    const gala = await createChatGala(pool);
    const refused = () => acquireTurnLock(gala.jamie, { connectionString: "postgres://nobody@127.0.0.1:1/none" });
    for (let tries = 0; tries < 3; tries += 1) await expect(refused()).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await (await acquireTurnLock(gala.jamie)).release();
  });

  it("refuses a message Postgres could not store before anything is asked of the model", async () => {
    const gala = await createChatGala(pool);
    const answer = await sendMessage(gala, "One\u0000two");
    expect(answer).toMatchObject({ status: 400, error: { code: "invalid_request" } });
    expect(await count("select count(*)::int as n from chat_messages where paddle_id = $1", [gala.jamie])).toBe(0);
  });

  it("lets go of the lock when a turn fails to store", async () => {
    const gala = await createChatGala(pool);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    // Postgres text can't hold NUL, so this reply can't be stored.
    scripted = scriptedModel(() => modelReply([textBlock("A reply with \u0000 in it")])).model;
    const failed = await sendMessage(gala, "One");
    quiet.mockRestore();
    expect(failed.error).toEqual({ code: "internal_error", message: "Something went wrong. Please try again." });
    expect(await count("select count(*)::int as n from chat_messages where paddle_id = $1", [gala.jamie])).toBe(0);
    const free = await acquireTurnLock(gala.jamie, { waitMs: 2_000 });
    await free.release();
  });
});

describe("who may talk to Glim", () => {
  it("answers 401 not_joined with no session, and with another event's cookie", async () => {
    const gala = await createChatGala(pool);
    const other = await createChatGala(pool);
    expect((await sendMessage({ slug: gala.slug, cookie: "" }, "Hi")).error?.code).toBe("not_joined");
    const wrongEvent = other.cookie.replace(other.slug, gala.slug);
    expect((await sendMessage({ slug: gala.slug, cookie: wrongEvent }, "Hi")).status).toBe(401);
  });
});
