/**
 * Galas priced like the demo for the autopilot's Postgres tests, built from time-relative
 * fixtures (never the story fixture, whose lots close at set evening times). Jamie is a real
 * guest; createPaddle inserts simulated paddles, so the guest's flag is flipped.
 */
import type pg from "pg";

import type { DatabaseClient } from "@/server/db/client";
import { placeBid } from "@/server/engine";
import type { AutopilotTrigger } from "@/server/glim/autopilot/types";
import type { PlanCard } from "@/server/glim/cards";
import { DEFAULT_RECORDINGS_DIR } from "@/server/glim/config";
import { createRecordedGlimModel } from "@/server/glim/recorded";
import { runGlimTurn } from "@/server/glim/turn";
import type { GlimModel } from "@/server/glim/client";
import { confirmPlan } from "@/server/plans/apply";
import { storeProposedPlan } from "@/server/plans/proposals";
import type { AutopilotClaim } from "@/server/plans/scan";
import { loadGlimState } from "@/server/queries/glim-state";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { createEvent, createHold, createLot, createPaddle } from "../engine/support/fixtures";

export const recordedModel = createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });

export interface Gala {
  eventId: string;
  jamie: string;
  rival: string;
  other: string;
  lots: { chef: string; wine: string; spa: string };
}

async function titled(pool: pg.Pool, lotId: string, title: string, category: string): Promise<void> {
  await pool.query("update lots set short_title = $2, title = $2, category = $3 where id = $1", [lotId, title, category]);
}

/**
 * Chef's Table at $320 (Jamie, by hand), Wine Tasting at $210 and Spa Day at $85, as in the
 * demo's opening bids; $500 held by Jamie, plenty by the others.
 */
export async function createGala(
  pool: pg.Pool,
  options: { holdCents?: number; closesInSeconds?: Partial<Record<keyof Gala["lots"], number>> } = {},
): Promise<Gala> {
  const eventId = await createEvent(pool);
  const jamie = await createPaddle(pool, eventId, 142);
  await pool.query("update paddles set is_simulated = false, first_name = 'Jamie' where id = $1", [jamie]);
  const rival = await createPaddle(pool, eventId, 88);
  const other = await createPaddle(pool, eventId, 90);
  await createHold(pool, eventId, jamie, options.holdCents ?? 50_000);
  await createHold(pool, eventId, rival, 100_000);
  await createHold(pool, eventId, other, 100_000);
  const closes = options.closesInSeconds ?? {};
  const chef = await createLot(pool, eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 2_000, closesInSeconds: closes.chef ?? 3_600 });
  const wine = await createLot(pool, eventId, { number: 9, startingBidCents: 12_000, minRaiseCents: 1_000, closesInSeconds: closes.wine ?? 3_600 });
  const spa = await createLot(pool, eventId, { number: 12, startingBidCents: 4_000, minRaiseCents: 500, closesInSeconds: closes.spa ?? 3_600 });
  await titled(pool, chef, "Chef’s Table", "dining");
  await titled(pool, wine, "Wine Tasting", "dining");
  await titled(pool, spa, "Spa Day", "wellness");
  const engine = { pool };
  for (const [paddleId, lotId, cents] of [
    [other, wine, 21_000],
    [other, spa, 8_500],
    [jamie, chef, 32_000],
  ] as const) {
    const placed = await placeBid(paddleId, lotId, cents, "guest", engine);
    if (!placed.ok) throw new Error(`setup bid refused: ${placed.refusal.reason}`);
  }
  return { eventId, jamie, rival, other, lots: { chef, wine, spa } };
}

export async function heart(pool: pg.Pool, paddleId: string, lotId: string): Promise<void> {
  await pool.query("insert into favorites (paddle_id, lot_id) values ($1, $2) on conflict do nothing", [paddleId, lotId]);
}

/** The guest's message through Glim (recorded by default), stored as a proposed plan card. */
export async function propose(
  database: DatabaseClient,
  paddleId: string,
  options: { guestText?: string; model?: GlimModel } = {},
): Promise<{ planId: string; card: PlanCard }> {
  const guestText = options.guestText ?? GOLDEN_SENTENCE;
  const state = await loadGlimState({ paddleId }, database);
  if (!state) throw new Error("no paddle");
  const result = await runGlimTurn({
    state,
    transcript: [],
    guestText,
    usageSoFar: { paddleMessages: 0, eventMessages: 0, tokensToday: 0 },
    dailyTokenBudget: 1_000_000,
    model: options.model ?? recordedModel,
  });
  if (result.card?.type !== "plan" || !result.proposal) throw new Error(`no plan card: ${result.error ?? result.reply}`);
  const stored = await storeProposedPlan({
    paddleId,
    guestText,
    reply: result.reply,
    card: result.card,
    proposal: result.proposal,
    model: result.model,
    pool: database.pool,
  });
  return { planId: stored.planId, card: result.card };
}

/** Proposes and confirms: the guest clicks Start bidding on the card. */
export async function startBidding(database: DatabaseClient, paddleId: string, options: Parameters<typeof propose>[2] = {}) {
  const proposed = await propose(database, paddleId, options);
  // Older than two minutes is not needed: a confirmed card is no longer proposed.
  const confirmed = await confirmPlan({ paddleId, proposedPlanId: proposed.planId, pool: database.pool });
  if (!confirmed.ok) throw new Error(`confirmPlan failed: ${confirmed.reason}`);
  return { ...proposed, confirmed };
}

export async function bid(pool: pg.Pool, paddleId: string, lotId: string, cents: number) {
  const placed = await placeBid(paddleId, lotId, cents, "guest", { pool });
  if (!placed.ok) throw new Error(`bid refused: ${placed.refusal.reason}`);
  return placed;
}

/** The debounce has passed: the paddle is due now. */
export async function makeDue(pool: pg.Pool, paddleId: string): Promise<void> {
  await pool.query("update glim_autopilot set due_at = now() - interval '1 millisecond' where paddle_id = $1 and due_at is not null", [
    paddleId,
  ]);
}

/** A claim built by hand, for running the gate on a paddle the scanner would not read. */
export function handClaim(paddleId: string, eventId: string, reasons: AutopilotTrigger[]): AutopilotClaim {
  return { paddleId, eventId, reasons, attempts: 0, lease: new Date(0) };
}

/** A model that fails the test if it is called. */
export function forbiddenModel(): GlimModel & { calls: number } {
  const model = {
    mode: "live" as const,
    calls: 0,
    async respond(): Promise<never> {
      model.calls += 1;
      throw new Error("the model must not be called");
    },
  };
  return model;
}

export async function rows<T extends Record<string, unknown>>(pool: pg.Pool, text: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(text, values)).rows;
}
