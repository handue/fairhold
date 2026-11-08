/**
 * A plan card waiting for Start bidding: a glim_plans row in status proposed whose proposal holds
 * the model's validated intent and the exact card the guest saw (proposal.card), with its items
 * and the two chat messages behind it. confirmPlan reads the card back through planCardSchema, so
 * the mandate covers exactly what the card showed. Day 3's chat persistence stores proposals here.
 */
import { z } from "zod";

import type pg from "pg";

import { getPool } from "@/server/db/client";
import type { PlanCard } from "@/server/glim/cards";
import type { GlimProposalRecord } from "@/server/glim/turn";

import { withPlanTransaction } from "./db";

const cents = z.number().int();
const lotRef = z.object({ lotId: z.string().min(1), lotNumber: z.number().int().positive(), shortTitle: z.string() });

/**
 * A stored plan card. Cards stored before autopilot existed have no autopilot fields; they read
 * as autopilot off, so confirming one never arms Glim on its own. A card stored before
 * mandateBudgetCents existed states its named budget, as its rules line did then.
 */
export const planCardSchema = z
  .object({
    type: z.literal("plan"),
    kind: z.enum(["new", "change"]),
    replacesPlanId: z.string().nullable(),
    tool: z.enum(["propose_plan", "propose_change"]),
    budgetCents: cents,
    totalCents: cents,
    holdCents: cents,
    availableCents: cents,
    items: z.array(
      lotRef.extend({
        priority: z.number().int().positive(),
        maxCents: z.number().int().positive(),
        capCents: cents.nullable(),
        statusText: z.string(),
      }),
    ),
    adjusted: z.boolean(),
    notes: z.array(z.string()),
    backups: z.array(lotRef.extend({ source: z.enum(["words", "heart"]), statusText: z.string() })).default([]),
    excluded: z.array(lotRef).default([]),
    excludedLotNumbers: z.array(z.number().int()).default([]),
    namedBudgetCents: cents.nullable().default(null),
    mandateBudgetCents: cents.nullable().optional(),
    autopilot: z.boolean().default(false),
  })
  .transform((card) => ({ ...card, mandateBudgetCents: card.mandateBudgetCents === undefined ? card.namedBudgetCents : card.mandateBudgetCents }));

export interface StoreProposedPlanInput {
  paddleId: string;
  /** The guest's message the card answers; it becomes the mandate's guest words on confirm. */
  guestText: string;
  /** Glim's reply text next to the card (often empty). */
  reply: string;
  card: PlanCard;
  proposal: GlimProposalRecord;
  model: string | null;
  pool?: pg.Pool;
}

export interface StoredProposal {
  planId: string;
  guestMessageId: string;
  cardMessageId: string;
}

export async function storeProposedPlan(input: StoreProposedPlanInput): Promise<StoredProposal> {
  const pool = input.pool ?? getPool();
  return withPlanTransaction(pool, async ({ client }) => {
    const guest = await client.query<{ id: string }>(
      "insert into chat_messages (paddle_id, role, text) values ($1, 'guest', $2) returning id",
      [input.paddleId, input.guestText],
    );
    const guestMessageId = guest.rows[0]?.id;
    if (!guestMessageId) throw new Error("no guest message id");
    const plan = await client.query<{ id: string }>(
      `insert into glim_plans (paddle_id, status, budget_cents, proposal, model, source_message_id)
       values ($1, 'proposed', $2, $3::jsonb, $4, $5) returning id`,
      [input.paddleId, input.card.budgetCents, JSON.stringify({ ...input.proposal, card: input.card }), input.model, guestMessageId],
    );
    const planId = plan.rows[0]?.id;
    if (!planId) throw new Error("no plan id");
    for (const item of input.card.items) {
      await client.query(
        "insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, $3, $4, 'watching')",
        [planId, item.lotId, item.priority, item.maxCents],
      );
    }
    const message = await client.query<{ id: string }>(
      `insert into chat_messages (paddle_id, role, text, card_type, card, plan_id, model)
       values ($1, 'glim', $2, 'plan', $3::jsonb, $4, $5) returning id`,
      [input.paddleId, input.reply, JSON.stringify(input.card), planId, input.model],
    );
    const cardMessageId = message.rows[0]?.id;
    if (!cardMessageId) throw new Error("no card message id");
    return { planId, guestMessageId, cardMessageId };
  });
}
