/**
 * What 07's panel reads for design/21 and design/22 on Postgres, through the routes a browser calls:
 * the prepared raise's card and its two buttons (V3), Skip on Glim's own card (V2), the header's
 * "Deciding…", a plan change and its "Update plan" or "Update and resume" (design/22 #9, B4), and the
 * panel once bidding closes (#12).
 */
import { describe, expect, it } from "vitest";

import { POST as postDismiss } from "@/app/api/glim/[slug]/raises/[actionId]/dismiss/route";
import { POST as postRaise } from "@/app/api/glim/[slug]/raises/[actionId]/route";
import { syncEventCards } from "@/server/chat/event-card-sync";
import type { AutopilotCardView, AutopilotRaiseCardView, ChatView } from "@/server/chat/types";
import { loadAutopilotRead } from "@/server/plans/context";
import { loadOpenRaiseOffer } from "@/server/plans/raise-offer";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { goldenProposal, modelReply, scriptedModel, toolUseBlock } from "../../unit/glim/helpers";
import { bid, heart, makeDue, recordedModel, rows, startBidding } from "../plans/support";

import {
  clickEdit,
  clickPause,
  clickResume,
  clickSkip,
  clickStartBidding,
  createChatGala,
  eventLines,
  lastPlanCard,
  readView,
  sendMessage,
  type ChatGala,
} from "./support";

const database = getTestDatabase();
const { pool } = database;
const ORIGIN = "https://fairhold.example";

function post(path: string, cookie: string, body: unknown = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie },
    body: JSON.stringify(body),
  });
}

async function json<T>(response: Response): Promise<{ status: number; body: T }> {
  return { status: response.status, body: (await response.json()) as T };
}

const approve = async (gala: ChatGala, actionId: string, body: unknown = { next: `/e/${gala.slug}/lots/07` }) =>
  json<{ holdId: string; amountCents: number; approvalUrl: string } & { error?: { code: string } }>(
    await postRaise(post(`/api/glim/${gala.slug}/raises/${actionId}`, gala.cookie, body), { params: Promise.resolve({ slug: gala.slug, actionId }) }),
  );

const notNow = async (gala: ChatGala, actionId: string) =>
  json<ChatView>(await postDismiss(post(`/api/glim/${gala.slug}/raises/${actionId}/dismiss`, gala.cookie), { params: Promise.resolve({ slug: gala.slug, actionId }) }));

async function runDue(paddleId: string) {
  await syncEventCards({ paddleId, pool });
  await scanFacts(pool);
  await makeDue(pool, paddleId);
  const [claim] = await claimDue(pool, { limit: 4 });
  if (!claim) throw new Error("nothing was due");
  return runAutopilot(claim, { database, model: recordedModel });
}

const lastCardOf = <T extends ChatView["messages"][number]["card"]>(view: ChatView, type: string) =>
  [...view.messages].reverse().find((message) => message.card?.type === type)?.card as T | undefined;

/** "$800. I really want the chef's dinner. Spa only under $120.", then the rival's $360 and $400. */
async function preparedRaise() {
  const gala = await createChatGala(pool);
  let call = 0;
  const chat = scriptedModel(() => modelReply([toolUseBlock("propose_plan", goldenProposal(call++ === 0 ? 800 : 500))]));
  await startBidding(database, gala.jamie, { guestText: "$800. I really want the chef's dinner. Spa only under $120.", model: chat.model });
  await bid(pool, gala.rival, gala.lots.chef, 36_000);
  await bid(pool, gala.rival, gala.lots.chef, 40_000);
  const report = await runDue(gala.jamie);
  expect(report.outcome).toBe("raise_prepared");
  const [action] = await rows<{ id: string; amount_cents: number }>(pool, "select id, amount_cents from glim_actions where id = $1", [report.actionId]);
  if (!action) throw new Error("no prepared raise");
  return { gala, action };
}

describe("V3: the raise Glim prepares", () => {
  it("shows the offer, and Approve opens PayPal for the stored amount, never one the browser sends", async () => {
    const { gala, action } = await preparedRaise();
    const card = lastCardOf<AutopilotRaiseCardView>(await readView(gala), "autopilot_raise");
    expect(card).toMatchObject({ actionId: action.id, ended: false, amountCents: action.amount_cents, dismissLabel: "Not now" });
    expect(card?.approveLabel).toBe(`Approve $${action.amount_cents / 100} in PayPal`);

    const opened = await approve(gala, action.id, { amountCents: 99_900, next: `/e/${gala.slug}/lots/07` });
    expect(opened.status).toBe(201);
    expect(opened.body.amountCents).toBe(action.amount_cents);
    expect(await rows(pool, "select amount_cents, status from holds where id = $1", [opened.body.holdId])).toEqual([
      { amount_cents: action.amount_cents, status: "pending_approval" },
    ]);
    // Opening the window holds nothing more: the bidding power is still $500.
    expect(await rows(pool, "select amount_cents from holds where paddle_id = $1 and status = 'authorized'", [gala.jamie])).toEqual([{ amount_cents: 50_000 }]);
  });

  it("ends with Not now: the card reads This offer ended, and nothing can open it again", async () => {
    const { gala, action } = await preparedRaise();
    const dismissed = await notNow(gala, action.id);
    expect(dismissed.status).toBe(200);
    expect(lastCardOf<AutopilotRaiseCardView>(dismissed.body, "autopilot_raise")).toMatchObject({ ended: true, endedLabel: "This offer ended" });
    expect(await loadOpenRaiseOffer(pool, gala.jamie)).toBeNull();
    // The autopilot no longer treats it as pending either.
    expect((await loadAutopilotRead(gala.jamie, [], database))?.context?.pendingRaise).toBeNull();

    const refused = await approve(gala, action.id);
    expect(refused).toMatchObject({ status: 409, body: { error: { code: "offer_ended" } } });
    // Asking twice changes nothing.
    expect((await notNow(gala, action.id)).status).toBe(200);
  });

  it("refuses another guest's offer, and an id that isn't one", async () => {
    const { action } = await preparedRaise();
    const stranger = await createChatGala(pool);
    expect((await approve(stranger, action.id)).status).toBe(409);
    expect((await approve(stranger, "not-an-offer")).status).toBe(404);
  });

  it("ends once bidding closes", async () => {
    const { gala, action } = await preparedRaise();
    await pool.query("update events set status = 'closed', closed_at = now() where id = $1", [gala.eventId]);
    expect(lastCardOf<AutopilotRaiseCardView>(await readView(gala), "autopilot_raise")?.ended).toBe(true);
    expect((await approve(gala, action.id)).status).toBe(409);
  });

  it("waits through Pause and is open again after Resume, which keep the plan it was prepared for", async () => {
    const { gala, action } = await preparedRaise();
    expect((await clickPause(gala)).status).toBe(200);
    expect(await loadOpenRaiseOffer(pool, gala.jamie)).toBeNull();
    expect((await clickResume(gala)).status).toBe(200);
    expect(await loadOpenRaiseOffer(pool, gala.jamie)).toEqual({ actionId: action.id, amountCents: action.amount_cents });
    expect((await loadAutopilotRead(gala.jamie, [], database))?.context?.pendingRaise).toMatchObject({ actionId: action.id });
    expect(lastCardOf<AutopilotRaiseCardView>(await readView(gala), "autopilot_raise")?.ended).toBe(false);
  });
});

describe("V2: Glim's own card", () => {
  it("offers Skip on the lot it added until the guest takes it, and Skip stops Glim there", async () => {
    const gala = await createChatGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    expect((await runDue(gala.jamie)).outcome).toBe("applied");

    const view = await readView(gala);
    const moved = lastCardOf<AutopilotCardView>(view, "autopilot");
    expect(moved).toMatchObject({
      whatLine: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.",
      rulesLine: "Your rules: $500 in all · Spa Day up to $120",
      skip: { label: "Skip Wine Tasting" },
      skipLotNumber: 9,
      chip: { kind: "winning", amountCents: 22_000 },
    });
    // V4: 10's feed row shows the bid, not the new maximum.
    expect(await rows(pool, "select amount_cents, detail->>'chipCents' as chip_cents from glim_actions where id = $1", [moved?.actionId])).toEqual([
      { amount_cents: 38_000, chip_cents: "22000" },
    ]);

    const skipped = await clickSkip(gala, 9);
    expect(skipped.status).toBe(200);
    expect(eventLines(skipped.view).at(-1)).toBe("I stopped bidding on Wine Tasting. Your $220 bid stands.");
    expect(lastCardOf<AutopilotCardView>(skipped.view as ChatView, "autopilot")?.skipLotNumber).toBeNull();
  });
});

describe("the header while Glim decides (design/21 #4)", () => {
  it("reads Deciding… from the run's first row until its last", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    expect((await clickStartBidding(gala, card.planId)).view?.status.text).toBe("On duty · $500 held with PayPal");
    const runId = "3f0b8f9e-0c1f-4b1a-9d55-1c2d3e4f5a6b";
    await pool.query("insert into event_log (event_id, paddle_id, type, payload) values ($1, $2, 'glim', $3::jsonb)", [
      gala.eventId,
      gala.jamie,
      JSON.stringify({ kind: "autopilot_deciding", runId }),
    ]);
    expect((await readView(gala)).status).toEqual({ tone: "on", mark: "deciding", text: "Deciding…" });
    await pool.query("insert into event_log (event_id, paddle_id, type, payload) values ($1, $2, 'glim', $3::jsonb)", [
      gala.eventId,
      gala.jamie,
      JSON.stringify({ kind: "autopilot_finished", runId, outcome: "kept", chatMessageId: null }),
    ]);
    expect((await readView(gala)).status.text).toBe("On duty · $500 held with PayPal");
  });
});

describe("a plan change (design/22 #7–#9, #18)", () => {
  async function running() {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    const started = await clickStartBidding(gala, card.planId);
    return { gala, card: lastPlanCard(started.view) };
  }

  it("opens the running plan's editor with its figures, and comes back as My new plan with what each was", async () => {
    const { gala, card } = await running();
    expect(card.state).toBe("running");
    expect(card.edit).toMatchObject({ planId: card.planId, holdCents: 50_000, outsideCents: 0 });
    expect(card.edit?.items.map((item) => [item.lotNumber, item.maxCents, item.minCents, item.minIsOwnBid])).toEqual([
      [7, 38_000, 32_000, true],
      [12, 12_000, 9_000, true],
    ]);

    const edited = await clickEdit(gala, card.planId, [
      { lotNumber: 7, maxCents: 41_000 },
      { lotNumber: 12, maxCents: 9_000 },
    ]);
    expect(edited.status).toBe(200);
    const change = lastPlanCard(edited.view);
    expect(change).toMatchObject({ state: "proposed", eyebrow: "My new plan for you", startLabel: "Update plan" });
    expect(change.items.map((item) => [item.maxCents, item.wasCents])).toEqual([
      [41_000, 38_000],
      [9_000, 12_000],
    ]);
    // The maximums fill the $500, so the first lot takes the rest, as a change in words would.
    expect(change.onMyOwn?.rules).toBe("Never past $500 in all, and Spa Day up to $90.");

    const updated = await clickStartBidding(gala, change.planId);
    expect(updated.status).toBe(200);
    const plans = (updated.view?.messages ?? []).flatMap((message) => (message.card?.type === "plan" ? [message.card] : []));
    expect(plans.map((plan) => plan.stateLine?.replace(/\d+:\d\d [AP]M/, "T"))).toEqual(["Replaced at T", "Started at T"]);
    expect(updated.view?.messages.find((message) => message.card?.type === "event" && message.card.eyebrow.endsWith("PLAN EDITED"))?.card).toMatchObject({
      line: "Chef’s Table up to $410, Spa Day up to $90.",
    });
    expect(await rows(pool, "select kind from glim_actions where paddle_id = $1 and kind in ('plan_started', 'plan_edited') order by created_at", [gala.jamie])).toEqual([
      { kind: "plan_started" },
      { kind: "plan_edited" },
    ]);
  });

  it("keeps every typed maximum as the guest's own cap when they don't fill the budget", async () => {
    const { gala, card } = await running();
    const edited = await clickEdit(gala, card.planId, [
      { lotNumber: 7, maxCents: 36_000 },
      { lotNumber: 12, maxCents: 10_000 },
    ]);
    expect(lastPlanCard(edited.view).onMyOwn?.rules).toBe("Never past $500 in all, Chef’s Table up to $360, and Spa Day up to $100.");
  });

  it("reads Update and resume while Glim is paused (B4), and confirming it resumes", async () => {
    const { gala, card } = await running();
    await clickPause(gala);
    const edited = await clickEdit(gala, card.planId, [{ lotNumber: 7, maxCents: 38_000 }]);
    const change = lastPlanCard(edited.view);
    expect(change.startLabel).toBe("Update and resume");
    const updated = await clickStartBidding(gala, change.planId);
    expect(updated.view?.status).toMatchObject({ mark: "on", text: "On duty · $500 held with PayPal" });
    expect(updated.view?.planControl).toBe("pause");
    expect(await rows(pool, "select paused_at is not null as paused from bid_limits where paddle_id = $1 and owner = 'glim' and active", [gala.jamie])).toEqual([
      { paused: false },
    ]);
  });
});

describe("once bidding closes (design/22 #12)", () => {
  it("is off duty, closes the input, and ends with what was won and the receipt", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    await pool.query("update lots set status = 'closed', closes_at = now(), winning_paddle_id = high_paddle_id, winning_cents = current_bid_cents where event_id = $1", [gala.eventId]);
    await pool.query("update events set status = 'closed', closed_at = now() where id = $1", [gala.eventId]);

    const view = await readView(gala);
    expect(view.status.text).toMatch(/^Off duty since \d+:\d\d [AP]M$/);
    expect(view.planControl).toBeNull();
    expect(view.quickReplies).toEqual([]);
    expect(view.inputClosed).toBe("Bidding has closed.");
    expect(view.closing).toMatchObject({
      eyebrow: expect.stringMatching(/^\d+:\d\d [AP]M · BIDDING CLOSED$/),
      line: "You won both lots in your plan. You’ll pay $410 with PayPal, and the other $90 will be released.",
      receipt: { label: "See my receipt", href: `/e/${gala.slug}/receipt` },
    });
  });
});
