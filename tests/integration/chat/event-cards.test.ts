/**
 * Event cards on Postgres: a fact on the paddle's channel becomes one action, one card and one
 * chat_card row, however many writers try at once. Glim's own moves are told once, on their own card.
 */
import { describe, expect, it } from "vitest";

import { startBidding } from "@/server/chat/actions";
import { syncEventCards } from "@/server/chat/event-card-sync";
import { closeDueLots } from "@/server/engine";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";
import { runChatTurn } from "@/server/chat/turn";
import type { ChatMessageView } from "@/server/chat/types";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { expireLot } from "../engine/support/fixtures";
import { bid, heart, makeDue, recordedModel, rows } from "../plans/support";

import { createChatGala, eventLines, readView, sendMessage, lastPlanCard, clickStartBidding, type ChatGala } from "./support";

const database = getTestDatabase();
const { pool } = database;

async function runningGala(): Promise<ChatGala> {
  const gala = await createChatGala(pool);
  const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
  await clickStartBidding(gala, card.planId);
  return gala;
}

/** design/22 #13: Start bidding's own card comes first, before the opening bid's. */
const PLAN_STARTED = "Chef’s Table up to $380, Spa Day up to $120.";

const eventCards = (messages: readonly ChatMessageView[]) =>
  messages.flatMap((message) => (message.card?.type === "event" ? [message.card] : []));

describe("a rival's bid", () => {
  it("is answered with 07's card, chip and all, on the paddle's channel", async () => {
    const gala = await runningGala();
    await bid(pool, gala.rival, gala.lots.chef, 36_000);

    expect(await syncEventCards({ pool })).toBe(1);

    const view = await readView(gala);
    const card = eventCards(view.messages).at(-1);
    expect(card).toMatchObject({
      type: "event",
      line: "Someone bid $360. I raised to $380, your limit for this lot.",
      chip: { kind: "winning", amountCents: 38_000 },
    });
    expect(card?.eyebrow).toMatch(/^\d+:\d\d [AP]M · CHEF’S TABLE$/);

    const [action] = await rows<{ id: string; kind: string; amount_cents: number; limit_cents: number; hold_cents_at_time: number; chip: string; message: string; trigger_bid_id: string | null; source_event_log_id: string }>(
      pool,
      "select id, kind, amount_cents, limit_cents, hold_cents_at_time, chip, message, trigger_bid_id, source_event_log_id from glim_actions where paddle_id = $1 and kind = 'raise'",
      [gala.jamie],
    );
    expect(action).toMatchObject({ amount_cents: 38_000, limit_cents: 38_000, hold_cents_at_time: 50_000, chip: "winning", message: card?.line });
    const [trigger] = await rows<{ amount_cents: number; paddle_id: string }>(pool, "select amount_cents, paddle_id from bids where id = $1", [action?.trigger_bid_id]);
    expect(trigger).toEqual({ amount_cents: 36_000, paddle_id: gala.rival });

    const channel = await rows<{ paddle_id: string; payload: { chatMessageId: string; actionId: string } }>(
      pool,
      "select paddle_id, payload from event_log where type = 'glim' and payload->>'kind' = 'chat_card' and payload->>'actionId' = $1",
      [action?.id],
    );
    expect(channel).toHaveLength(1);
    expect(channel[0]?.paddle_id).toBe(gala.jamie);
    expect(view.messages.some((message) => message.id === channel[0]?.payload.chatMessageId)).toBe(true);
  });

  it("past the limit gets its own sentence, and the raises before it stay", async () => {
    const gala = await runningGala();
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    expect(eventLines(await readView(gala))).toEqual([
      PLAN_STARTED,
      "I bid $90 for you. I’ll go up to $120.",
      "Someone bid $360. I raised to $380, your limit for this lot.",
      "Someone bid $400, over your $380 limit.",
    ]);
  });
});

describe("the templater", () => {
  it("writes each card once, whoever runs and however often", async () => {
    const gala = await runningGala();
    await bid(pool, gala.rival, gala.lots.spa, 9_500);
    const written = await Promise.all([syncEventCards({ pool }), syncEventCards({ paddleId: gala.jamie, pool }), syncEventCards({ pool })]);
    expect(written.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await syncEventCards({ pool })).toBe(0);
    expect(eventLines(await readView(gala))).toEqual([PLAN_STARTED, "I bid $90 for you. I’ll go up to $120.", "Someone bid $95. I raised to $100."]);
    const [counts] = await rows<{ actions: number; cards: number }>(
      pool,
      `select (select count(*)::int from glim_actions where paddle_id = $1 and source_event_log_id is not null) as actions,
              (select count(*)::int from chat_messages where paddle_id = $1 and card_type = 'event') as cards`,
      [gala.jamie],
    );
    // The two facts' cards, and Start bidding's own, which answers no fact.
    expect(counts).toEqual({ actions: 2, cards: 3 });
  });

  it("says nothing to a guest who never started a plan, or about a simulated guest's limits", async () => {
    const gala = await createChatGala(pool);
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await pool.query("update paddles set is_simulated = true where id = $1", [gala.jamie]);
    await syncEventCards({ pool });
    await pool.query("update paddles set is_simulated = false where id = $1", [gala.jamie]);
    expect(eventLines(await readView(gala))).toEqual([]);
    expect(await rows(pool, "select id from glim_actions where paddle_id = $1", [gala.jamie])).toEqual([]);
  });

  it("tells a lot won and a lot lost when they close", async () => {
    const gala = await runningGala();
    await expireLot(pool, gala.lots.spa);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await expireLot(pool, gala.lots.chef);
    await closeDueLots(undefined, { pool });
    const view = await readView(gala);
    const cards = eventCards(view.messages);
    expect(cards.map((card) => card.line).slice(-2).sort()).toEqual([
      "Bidding closed at $400. You didn’t win, so you won’t be charged.",
      "Bidding closed. You won at $90.",
    ]);
    // design/22 #20 and #21: the lime Won chip, and 10's grey Closed.
    expect(cards.slice(-2).map((card) => card.chip?.kind).sort()).toEqual(["closed", "won"]);
    expect(cards.find((card) => card.chip?.kind === "won")?.chip).toEqual({ kind: "won", amountCents: 9_000 });
    const items = lastPlanCard(view).items.map((item) => item.statusText);
    expect(items).toEqual(["Closed", "Won at $90"]);
  });

  it("tells nothing about lots that closed before the guest's first plan", async () => {
    const gala = await createChatGala(pool, { holdCents: 80_000 });
    await bid(pool, gala.jamie, gala.lots.wine, 22_000);
    await bid(pool, gala.rival, gala.lots.wine, 23_000);
    await expireLot(pool, gala.lots.wine);
    await closeDueLots(undefined, { pool });
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    expect(eventLines(await readView(gala))).toEqual([PLAN_STARTED, "I bid $90 for you. I’ll go up to $120."]);
  });
});

describe("under load", () => {
  it("keeps up with bids, closes and other writers: one card per fact, none lost, no deadlock", async () => {
    const gala = await createChatGala(pool, { closesInSeconds: { spa: 2 } });
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    // Rivals bid up Chef's Table, each answered by Glim's limit until it runs out, while the templater
    // runs from two sides and the spa's lot closes.
    const amounts = [34_000, 36_000, 38_500, 40_000, 44_000, 48_000];
    for (const cents of amounts) {
      await Promise.all([
        bid(pool, gala.rival, gala.lots.chef, cents).catch(() => null),
        syncEventCards({ pool }),
        syncEventCards({ paddleId: gala.jamie, pool }),
        closeDueLots(undefined, { pool }),
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await closeDueLots(undefined, { pool });
    await syncEventCards({ pool });

    const facts = await rows<{ n: number }>(
      pool,
      `select count(*)::int as n from event_log where paddle_id = $1 and payload->>'kind' in ('limit_raised', 'limit_exhausted', 'lot_won', 'lot_lost')`,
      [gala.jamie],
    );
    const [counts] = await rows<{ actions: number; cards: number; distinct_sources: number }>(
      pool,
      `select count(*)::int as actions, count(distinct source_event_log_id)::int as distinct_sources,
         (select count(*)::int from chat_messages where paddle_id = $1 and card_type = 'event') as cards
       from glim_actions where paddle_id = $1 and source_event_log_id is not null`,
      [gala.jamie],
    );
    expect(facts[0]?.n).toBeGreaterThan(3);
    const n = facts[0]?.n ?? 0;
    expect(counts).toEqual({ actions: n, cards: n + 1, distinct_sources: n });
    expect(eventLines(await readView(gala))).toContain("Bidding closed. You won at $90.");
  });
});

describe("an autopilot move", () => {
  async function golden() {
    const gala = await createChatGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    const turn = await runChatTurn({ paddleId: gala.jamie, eventId: gala.eventId, text: GOLDEN_SENTENCE, autopilot: true, database });
    if (!turn.planId) throw new Error("no plan");
    await startBidding({ paddleId: gala.jamie, eventId: gala.eventId }, turn.planId, pool);
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    // The tick's order: event cards first, then the autopilot's scan, claim and run.
    await syncEventCards({ pool });
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("no claim");
    const report = await runAutopilot(claim, { database, model: recordedModel });
    expect(report.outcome).toBe("applied");
    return gala;
  }

  it("gets no second card for its opening bid: the templater skips the limits it created", async () => {
    const gala = await golden();
    expect(await syncEventCards({ pool })).toBe(0);
    const view = await readView(gala);
    expect(eventLines(view)).toEqual([
      PLAN_STARTED,
      "I bid $90 for you. I’ll go up to $120.",
      "Someone bid $360. I raised to $380, your limit for this lot.",
      "Someone bid $400, over your $380 limit.",
    ]);
    const actions = await rows(pool, "select id from glim_actions where paddle_id = $1 and message = 'I bid $220 for you. I’ll go up to $380.'", [gala.jamie]);
    expect(actions).toEqual([]);
  });

  it("is stored behind the seam, after the fact it answers, for its image to be approved", async () => {
    const gala = await golden();
    const view = await readView(gala);
    const last = view.messages.at(-1);
    expect(last?.card?.type).toBe("autopilot");
    const previous = view.messages.at(-2);
    expect(previous?.card?.type === "event" && previous.card.line).toBe("Someone bid $400, over your $380 limit.");
  });

  it("still gets cards for what happens to that limit later", async () => {
    const gala = await golden();
    await bid(pool, gala.rival, gala.lots.wine, 23_000);
    await syncEventCards({ pool });
    expect(eventLines(await readView(gala)).at(-1)).toBe("Someone bid $230. I raised to $240.");
  });
});
