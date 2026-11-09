/**
 * What the guest does to their plan from the panel, besides talking: Start bidding, Edit, Skip, Pause
 * and Resume. Each goes through the one plan writer (src/server/plans), then posts what the chat
 * should show. Failures are ApiErrors whose message a guest can read in Glim's voice.
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { withTransaction } from "@/server/db/transaction";
import type { Refusal } from "@/server/engine";
import { buildPlanCard, type PlanCard } from "@/server/glim/cards";
import { NO_HOLD_LINE } from "@/server/glim/copy";
import { formatUsd } from "@/server/glim/money";
import type { GlimProposalRecord } from "@/server/glim/turn";
import type { PlanIntent } from "@/server/glim/types";
import { checkPlan } from "@/server/glim/validator";
import { confirmPlan, skipLot, type ConfirmPlanResult } from "@/server/plans/apply";
import { pausePlan, resumePlan } from "@/server/plans/pause";
import { dismissRaiseOffer, loadOpenRaiseOffer } from "@/server/plans/raise-offer";
import { planCardSchema, storeProposedPlan } from "@/server/plans/proposals";
import { loadGlimState } from "@/server/queries/glim-state";
import { appendEventLog } from "@/server/sse/notify";

import { syncEventCards } from "./event-card-sync";
import { eventEyebrow, planStartedCard } from "./event-cards";
import { frozenNow } from "./frozen-clock";
import { withTurnLock } from "./lock";
import { planCardsArmAutopilot } from "./switch";
import type { EventCard } from "./types";

export interface PlanActor {
  paddleId: string;
  eventId: string;
  eventSlug?: string;
}

const BIDDING_MOVED_ON = "Someone bid while you were reading, so this plan no longer fits. Tell me what you’d like now.";
const LOT_CLOSED = "A lot in this plan just closed, so the plan no longer fits. Tell me what you’d like now.";

function refusalError(refusal: Refusal): ApiError {
  switch (refusal.reason) {
    case "no_hold":
      return new ApiError(409, "no_hold", NO_HOLD_LINE);
    case "over_bidding_power":
      return new ApiError(
        409,
        "over_bidding_power",
        `This plan needs ${formatUsd(refusal.requiredCents)}, and you have ${formatUsd(refusal.availableCents)} of bidding power for it.`,
        { requiredCents: refusal.requiredCents, availableCents: refusal.availableCents, shortfallCents: refusal.shortfallCents },
      );
    case "below_minimum":
      return new ApiError(409, "below_minimum", BIDDING_MOVED_ON);
    case "lot_closed":
    case "not_open":
      return new ApiError(409, refusal.reason, LOT_CLOSED);
  }
}

function confirmError(failed: Extract<ConfirmPlanResult, { ok: false }>): ApiError {
  switch (failed.reason) {
    case "not_found":
      return new ApiError(404, "plan_not_found", "I can’t find that plan.");
    case "not_proposed":
      return new ApiError(409, "plan_not_proposed", "That plan was already started or replaced.");
    case "invalid_card":
    case "empty_card":
      return new ApiError(409, "plan_invalid", "I can’t start that plan. Tell me what you’d like and I’ll make a new one.");
    case "refused":
      return refusalError(failed.refusal);
  }
}

/** One row on the paddle's own channel, in its own transaction: the ordering lock is transaction-scoped. */
async function appendPaddleRow(pool: pg.Pool, actor: PlanActor, payload: { kind: string; [key: string]: string | number | null }): Promise<void> {
  await withTransaction(pool, (client) =>
    appendEventLog(client, [{ eventId: actor.eventId, paddleId: actor.paddleId, type: "glim", payload }]),
  );
}

/** A code-written line in the chat, with its row on the paddle's channel. */
async function postCard(pool: pg.Pool, actor: PlanActor, card: EventCard, planId: string | null): Promise<void> {
  await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into chat_messages (paddle_id, role, text, card_type, card, plan_id)
       values ($1, 'glim', '', 'event', $2::jsonb, $3) returning id`,
      [actor.paddleId, JSON.stringify(card), planId],
    );
    const chatMessageId = rows[0]?.id;
    if (!chatMessageId) throw new Error("no chat message id");
    await appendEventLog(client, [
      {
        eventId: actor.eventId,
        paddleId: actor.paddleId,
        type: "glim",
        payload: { kind: "chat_card", chatMessageId, actionId: card.actionId },
      },
    ]);
  });
}

async function eventClock(pool: pg.Pool, eventId: string): Promise<{ timezone: string; live: boolean; now: Date }> {
  const { rows } = await pool.query<{ timezone: string; status: string; now: Date }>(
    "select timezone, status, clock_timestamp() as now from events where id = $1",
    [eventId],
  );
  const row = rows[0];
  if (!row) throw new ApiError(404, "event_not_found", "This event doesn’t exist.");
  return { timezone: row.timezone, live: row.status === "live", now: row.now };
}

const biddingClosed = () => new ApiError(409, "event_closed", "Bidding has closed.");

/**
 * Start bidding: confirmPlan creates the card's limits and opening bids, all or nothing within the
 * hold. The opening bids' cards are posted at once rather than on the next tick.
 */
export async function startBidding(actor: PlanActor, planId: string, pool: pg.Pool = getDatabaseClient().pool): Promise<void> {
  const confirmed = await confirmPlan({ paddleId: actor.paddleId, proposedPlanId: planId, pool });
  if (!confirmed.ok) throw confirmError(confirmed);
  await appendPaddleRow(pool, actor, { kind: "plan_status", planId, status: "active", version: 1 });
  // design/22 #13 and #18, ahead of the opening bids' cards: "Plan started" or, after Update plan, "Plan edited".
  const clock = await eventClock(pool, actor.eventId);
  await postCard(
    pool,
    actor,
    planStartedCard({ at: clock.now, timezone: clock.timezone, edited: confirmed.replaced, line: confirmed.message, actionId: confirmed.actionId }),
    planId,
  );
  await syncEventCards({ paddleId: actor.paddleId, pool });
}

/** Skip: Glim stops on this lot at once. Bids stand, and a lot already skipped is left as it is. */
export async function skipPlanLot(actor: PlanActor, lotNumber: number, pool: pg.Pool = getDatabaseClient().pool): Promise<void> {
  const { rows } = await pool.query<{ lot_id: string; short_title: string; open: boolean; plan_id: string | null; item_status: string | null }>(
    `select l.id as lot_id, l.short_title, (l.status = 'open' and l.closes_at > clock_timestamp()) as open,
       g.id as plan_id, i.status as item_status
     from lots l
     left join glim_plans g on g.paddle_id = $1 and g.status in ('active', 'paused')
     left join glim_plan_items i on i.plan_id = g.id and i.lot_id = l.id
     where l.event_id = $2 and l.number = $3`,
    [actor.paddleId, actor.eventId, lotNumber],
  );
  const lot = rows[0];
  if (!lot) throw new ApiError(404, "lot_not_found", "I can’t find that lot.");
  if (lot.item_status === "skipped") return;
  if (!lot.plan_id || lot.item_status === null) throw new ApiError(409, "not_in_plan", "That lot isn’t in your plan.");
  if (!lot.open) throw new ApiError(409, "lot_closed", "That lot has closed.");

  const skipped = await skipLot({ paddleId: actor.paddleId, lotId: lot.lot_id, pool });
  if (!skipped.ok) throw new ApiError(409, "not_in_plan", "That lot isn’t in your plan.");
  const action = await pool.query<{ message: string }>("select message from glim_actions where id = $1", [skipped.actionId]);
  const clock = await eventClock(pool, actor.eventId);
  await postCard(
    pool,
    actor,
    {
      type: "event",
      actionId: skipped.actionId,
      at: clock.now.toISOString(),
      eyebrow: eventEyebrow(clock.now, clock.timezone, lot.short_title),
      line: action.rows[0]?.message ?? `I stopped bidding on ${lot.short_title}.`,
      chip: null,
    },
    lot.plan_id,
  );
}

const noPlan = () => new ApiError(409, "no_plan", "You don’t have a plan running.");

/** Pause: the plan's status and version move first (src/server/plans/pause.ts), then the limits stop. */
export async function pauseGlim(actor: PlanActor, pool: pg.Pool = getDatabaseClient().pool): Promise<void> {
  const clock = await eventClock(pool, actor.eventId);
  if (!clock.live) throw biddingClosed();
  const paused = await pausePlan({ paddleId: actor.paddleId, pool });
  if (!paused.ok) throw noPlan();
  if (!paused.changed) return;
  await postCard(
    pool,
    actor,
    {
      type: "event",
      actionId: paused.actionId,
      at: clock.now.toISOString(),
      eyebrow: eventEyebrow(clock.now, clock.timezone, "Paused"),
      line: paused.message ?? "",
      chip: null,
    },
    paused.planId,
  );
}

/** Resume: the limits bid again, and any bid they missed is answered at once, with its card. */
export async function resumeGlim(actor: PlanActor, pool: pg.Pool = getDatabaseClient().pool): Promise<void> {
  const clock = await eventClock(pool, actor.eventId);
  if (!clock.live) throw biddingClosed();
  const resumed = await resumePlan({ paddleId: actor.paddleId, pool });
  if (!resumed.ok) throw noPlan();
  if (resumed.changed) {
    await postCard(
      pool,
      actor,
      {
        type: "event",
        actionId: resumed.actionId,
        at: clock.now.toISOString(),
        eyebrow: eventEyebrow(clock.now, clock.timezone, "Resumed"),
        line: resumed.message ?? "",
        chip: null,
      },
      resumed.planId,
    );
  }
  await syncEventCards({ paddleId: actor.paddleId, pool });
}

export interface PlanEditItem {
  lotNumber: number;
  /** The guest's new maximum: on a change card every maximum is the guest's own cap. */
  maxCents: number;
}

/**
 * Edit: new maximums for a plan, in the guest's order, with any lot left out dropped. Code checks them
 * like any proposal and answers with a new card, which Start bidding then confirms; nothing changes
 * until it does. The card keeps the budget the plan was made for while the maximums still fit it.
 */
export async function editPlan(
  actor: PlanActor,
  planId: string,
  items: readonly PlanEditItem[],
  database: DatabaseClient = getDatabaseClient(),
): Promise<{ planId: string; card: PlanCard }> {
  const { pool } = database;
  return withTurnLock(actor.paddleId, async () => {
    const { rows } = await pool.query<{ proposal: { card?: unknown } | null; status: string }>(
      "select proposal, status from glim_plans where id = $1 and paddle_id = $2",
      [planId, actor.paddleId],
    );
    const plan = rows[0];
    if (!plan) throw new ApiError(404, "plan_not_found", "I can’t find that plan.");
    if (plan.status !== "proposed" && plan.status !== "active" && plan.status !== "paused") {
      throw new ApiError(409, "plan_not_proposed", "That plan was already replaced.");
    }
    const state = await loadGlimState({ paddleId: actor.paddleId, now: frozenNow(actor.eventSlug) }, database);
    if (!state) throw new ApiError(404, "paddle_not_found", "I can’t find your paddle.");

    const previous = planCardSchema.safeParse(plan.proposal?.card);
    const earlier = previous.success ? previous.data : null;
    const intent: PlanIntent = {
      tool: "propose_change",
      budgetCents: earlier?.budgetCents ?? null,
      items: items.map((item, index) => ({ lotNumber: item.lotNumber, priority: index + 1, capCents: item.maxCents })),
      backupLotNumbers: earlier?.backups.filter((backup) => backup.source === "words").map((backup) => backup.lotNumber) ?? [],
      excludedLotNumbers: earlier?.excludedLotNumbers ?? [],
    };
    // The plan's budget stays while the new maximums fit it; past it, only the bidding power bounds them.
    let check = checkPlan(intent, state);
    let keptBudget = true;
    if (check.issues.length > 0 && intent.budgetCents !== null) {
      intent.budgetCents = null;
      keptBudget = false;
      check = checkPlan(intent, state);
    }
    const [issue] = check.issues;
    if (issue || !check.allocation) {
      throw new ApiError(422, issue?.reason ?? "plan_rejected", issue?.message ?? "That plan doesn’t fit.", { issues: check.issues });
    }
    // Maximums that add up to the plan's budget leave its first lot as the one that takes the rest,
    // as a change in words does (design/22 #9: "Never past $500 in all, and Spa Day up to $90."). The
    // card is the same; only lots below the first keep the guest's figure as their own cap. Used
    // only when the allocator then gives every lot exactly what was typed.
    const typedTotal = items.reduce((sum, item) => sum + item.maxCents, 0);
    if (keptBudget && intent.budgetCents !== null && typedTotal === intent.budgetCents && intent.items.length > 0) {
      const open: PlanIntent = { ...intent, items: intent.items.map((item, index) => (index === 0 ? { ...item, capCents: null } : item)) };
      const openCheck = checkPlan(open, state);
      const same = openCheck.allocation?.items.every((allocated) => items.some((item) => item.lotNumber === allocated.lot.number && item.maxCents === allocated.maxCents));
      if (openCheck.issues.length === 0 && openCheck.allocation && same) {
        intent.items = open.items;
        check = openCheck;
      }
    }
    if (!check.allocation) throw new ApiError(422, "plan_rejected", "That plan doesn’t fit.");
    const namedBudgetCents = keptBudget ? (earlier?.namedBudgetCents ?? null) : null;
    const autopilot = planCardsArmAutopilot();
    const card = buildPlanCard({ tool: "propose_change", allocation: check.allocation, state, adjustments: [], intent, namedBudgetCents, autopilot });
    const proposal: GlimProposalRecord = { tool: "propose_change", input: { items }, intent, adjusted: false, namedBudgetCents };
    const stored = await storeProposedPlan({ paddleId: actor.paddleId, guestText: null, reply: "", card, proposal, model: null, pool });
    return { planId: stored.planId, card };
  });
}

const offerEnded = () => new ApiError(409, "offer_ended", "This offer ended.");

/**
 * V3's "Approve $600 in PayPal": the amount of the raise Glim prepared, read from the stored action
 * while the offer is still open, never from the request. The route hands it to createHold, which
 * opens the PayPal window; nothing more is held until the guest approves there.
 */
export async function raiseOfferAmount(actor: PlanActor, actionId: string, pool: pg.Pool = getDatabaseClient().pool): Promise<number> {
  const offer = await loadOpenRaiseOffer(pool, actor.paddleId);
  if (!offer || offer.actionId !== actionId) throw offerEnded();
  return offer.amountCents;
}

/** V3's "Not now": the offer ends for good, and the card reads "This offer ended". Repeating it is harmless. */
export async function dismissRaise(actor: PlanActor, actionId: string, pool: pg.Pool = getDatabaseClient().pool): Promise<void> {
  await dismissRaiseOffer(pool, actor.paddleId, actionId);
}
