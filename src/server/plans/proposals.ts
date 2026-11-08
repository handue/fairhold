/**
 * A plan card waiting for Start bidding: a glim_plans row in status proposed whose proposal holds
 * the model's validated intent and the exact card the guest saw (proposal.card), with its items
 * and the two chat messages behind it. confirmPlan reads the card back through planCardSchema, so
 * the mandate covers exactly what the card showed. The chat (src/server/chat) stores proposals here.
 * A guest has at most one card waiting: a new one supersedes the last, so an older card on screen can
 * no longer be started.
 */
import { z } from "zod";

import type pg from "pg";

import { getPool } from "@/server/db/client";
import type { PlanCard } from "@/server/glim/cards";
import type { GlimTokenUsage } from "@/server/glim/client";
import type { GlimProposalRecord } from "@/server/glim/turn";

import { withPlanTransaction, type Queryable } from "./db";

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
  /**
   * The guest's message the card answers; it becomes the mandate's guest words on confirm. Null for
   * a card from the plan editor, which has no message behind it.
   */
  guestText: string | null;
  /** When the guest sent it, so a card posted during a slow reply reads after the message; now by default. */
  guestMessageAt?: Date;
  /** Glim's reply text next to the card (often empty). */
  reply: string;
  card: PlanCard;
  proposal: GlimProposalRecord;
  model: string | null;
  /** What the reply cost: the daily budget (tokensToday) reads tokens_used from the card's row. */
  usage?: GlimTokenUsage;
  tokensUsed?: number;
  latencyMs?: number;
  /** Runs in the same transaction once the rows exist, for what must commit with the card (the transcript). */
  alsoWrite?: (client: Queryable, stored: StoredProposal) => Promise<void>;
  pool?: pg.Pool;
}

export interface StoredProposal {
  planId: string;
  /** Null when the card has no guest message behind it. */
  guestMessageId: string | null;
  cardMessageId: string;
}

export async function storeProposedPlan(input: StoreProposedPlanInput): Promise<StoredProposal> {
  const pool = input.pool ?? getPool();
  return withPlanTransaction(pool, async ({ client }) => {
    await client.query("update glim_plans set status = 'superseded', ended_at = now() where paddle_id = $1 and status = 'proposed'", [
      input.paddleId,
    ]);
    let guestMessageId: string | null = null;
    if (input.guestText !== null) {
      const guest = await client.query<{ id: string }>(
        "insert into chat_messages (paddle_id, role, text, created_at) values ($1, 'guest', $2, coalesce($3, clock_timestamp())) returning id",
        [input.paddleId, input.guestText, input.guestMessageAt ?? null],
      );
      guestMessageId = guest.rows[0]?.id ?? null;
      if (!guestMessageId) throw new Error("no guest message id");
    }
    const plan = await client.query<{ id: string }>(
      `insert into glim_plans (paddle_id, status, budget_cents, proposal, model, source_message_id)
       values ($1, 'proposed', $2, $3::jsonb, $4, $5) returning id`,
      [input.paddleId, input.card.budgetCents, JSON.stringify({ ...input.proposal, card: input.card }), input.model, guestMessageId],
    );
    const planId = plan.rows[0]?.id;
    if (!planId) throw new Error("no plan id");
    // In lot-id order: each insert takes a key-share lock on its lot, and the engine locks lots in this order.
    for (const item of [...input.card.items].sort((a, b) => (a.lotId < b.lotId ? -1 : 1))) {
      await client.query(
        "insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status) values ($1, $2, $3, $4, 'watching')",
        [planId, item.lotId, item.priority, item.maxCents],
      );
    }
    const message = await client.query<{ id: string }>(
      `insert into chat_messages
         (paddle_id, role, text, card_type, card, plan_id, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, tokens_used, latency_ms)
       values ($1, 'glim', $2, 'plan', $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        input.paddleId,
        input.reply,
        JSON.stringify(input.card),
        planId,
        input.model,
        input.usage?.inputTokens ?? null,
        input.usage?.outputTokens ?? null,
        input.usage?.cacheReadTokens ?? null,
        input.usage?.cacheWriteTokens ?? null,
        input.tokensUsed ?? 0,
        input.latencyMs ?? null,
      ],
    );
    const cardMessageId = message.rows[0]?.id;
    if (!cardMessageId) throw new Error("no card message id");
    const stored: StoredProposal = { planId, guestMessageId, cardMessageId };
    await input.alsoWrite?.(client, stored);
    return stored;
  });
}
