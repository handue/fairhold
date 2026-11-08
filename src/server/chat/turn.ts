/**
 * One guest message, stored: the caps' counts, the state and the transcript go in, runGlimTurn does the
 * thinking, and what it returns is written in one transaction: chat_messages, transcriptAppend verbatim
 * to glim_transcript, rejections to glim_actions and a proposal through storeProposedPlan. Nothing here
 * bids; only the guest's Start bidding does. The caller holds the paddle's turn lock (lock.ts).
 */
import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { withTransaction, type Queryable } from "@/server/db/transaction";
import { appendEventLog } from "@/server/sse/notify";
import type { GlimModel } from "@/server/glim/client";
import { getGlimModel } from "@/server/glim/client";
import { getGlimConfig } from "@/server/glim/config";
import { FALLBACK_LINE } from "@/server/glim/copy";
import { runGlimTurn, type GlimStreamEvent, type GlimTurnResult } from "@/server/glim/turn";
import type { GlimActionRecord } from "@/server/glim/types";
import { storeProposedPlan } from "@/server/plans/proposals";
import { loadGlimState } from "@/server/queries/glim-state";

import { frozenNow } from "./frozen-clock";
import { planCardsArmAutopilot } from "./switch";
import { appendTranscript, loadTranscript } from "./transcript-store";
import { chatUsageSoFar } from "./usage";

export interface ChatTurnInput {
  paddleId: string;
  eventId: string;
  eventSlug?: string;
  text: string;
  /** The lot the guest opened Glim from ("Let Glim watch"), if any. */
  lotNumber?: number | null;
  onEvent?: (event: GlimStreamEvent) => void;
  signal?: AbortSignal;
  /** The process's model by default; tests pass their own. */
  model?: GlimModel;
  dailyTokenBudget?: number;
  /** Whether the card arms the autopilot; the one switch decides by default (switch.ts). */
  autopilot?: boolean;
  database?: DatabaseClient;
}

export interface ChatTurnOutcome {
  /** False when the turn was answered by a line that is not kept: the caps, an empty or too long message. */
  stored: boolean;
  guestText: string;
  reply: string;
  result: GlimTurnResult;
  /** The proposed plan a card was stored as. */
  planId: string | null;
}

/** Answered without a model call and not kept, so a capped guest can't grow the table. */
const UNSTORED_ERRORS: ReadonlySet<string> = new Set([
  "empty_message",
  "message_too_long",
  "paddle_messages",
  "event_messages",
  "daily_tokens",
]);

export async function runChatTurn(input: ChatTurnInput): Promise<ChatTurnOutcome> {
  const database = input.database ?? getDatabaseClient();
  const { pool } = database;
  const { paddleId, eventId } = input;
  // Postgres text can't hold NUL.
  const guestText = input.text.replaceAll("\u0000", "").trim();
  const autopilot = input.autopilot ?? planCardsArmAutopilot();
  const { rows } = await pool.query<{ now: Date }>("select clock_timestamp() as now");
  const guestMessageAt = rows[0]?.now ?? new Date();

  const [state, transcript, usageSoFar] = await Promise.all([
    loadGlimState({ paddleId, openedFromLotNumber: input.lotNumber ?? null, now: frozenNow(input.eventSlug) }, database),
    loadTranscript(pool, paddleId),
    chatUsageSoFar(pool, { paddleId, eventId }),
  ]);
  if (!state) throw new Error(`No paddle ${paddleId}`);

  const result = await runGlimTurn({
    state: { ...state, autopilotOff: !autopilot },
    transcript,
    guestText,
    usageSoFar,
    dailyTokenBudget: input.dailyTokenBudget ?? getGlimConfig().dailyTokenBudget,
    model: input.model ?? getGlimModel(),
    onEvent: input.onEvent,
    signal: input.signal,
    autopilot,
  });

  if (result.error !== null && UNSTORED_ERRORS.has(result.error)) {
    return { stored: false, guestText, reply: result.reply, result, planId: null };
  }

  // The card speaks for itself; a reply with neither text nor a card still has to say something.
  const reply = result.reply || (result.card ? "" : FALLBACK_LINE);
  const planId = await storeTurn({ paddleId, eventId, guestText, guestMessageAt, reply, result }, pool);
  return { stored: true, guestText, reply, result, planId };
}

interface StoredTurn {
  paddleId: string;
  eventId: string;
  guestText: string;
  guestMessageAt: Date;
  reply: string;
  result: GlimTurnResult;
}

async function storeTurn(turn: StoredTurn, pool: DatabaseClient["pool"]): Promise<string | null> {
  const { paddleId, eventId, result } = turn;
  // Another tab of this guest learns of the reply from this row. The last write before commit: the
  // event_log ordering lock is held from here on.
  const tellOtherTabs = (client: Queryable, chatMessageId: string) =>
    appendEventLog(client, [{ eventId, paddleId, type: "glim", payload: { kind: "chat_card", chatMessageId, actionId: null } }]);
  if (result.card?.type === "plan" && result.proposal) {
    const stored = await storeProposedPlan({
      paddleId,
      guestText: turn.guestText,
      guestMessageAt: turn.guestMessageAt,
      reply: turn.reply,
      card: result.card,
      proposal: result.proposal,
      model: result.model,
      usage: result.usage,
      tokensUsed: result.tokensUsed,
      latencyMs: result.latencyMs,
      pool,
      alsoWrite: async (client, { planId, guestMessageId, cardMessageId }) => {
        await appendTranscript(client, paddleId, result.transcriptAppend, { guestMessageId, glimMessageId: cardMessageId });
        await insertRejections(client, result.rejections, planId);
        await tellOtherTabs(client, cardMessageId);
      },
    });
    return stored.planId;
  }
  await withTransaction(pool, async (client) => {
    const guest = await client.query<{ id: string }>(
      "insert into chat_messages (paddle_id, role, text, created_at) values ($1, 'guest', $2, $3) returning id",
      [paddleId, turn.guestText, turn.guestMessageAt],
    );
    // A raise offer is the only other card; the panel tells them apart by card.type.
    const card = result.card;
    const reply = await client.query<{ id: string }>(
      `insert into chat_messages
         (paddle_id, role, text, card_type, card, model, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, tokens_used, latency_ms, error)
       values ($1, 'glim', $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [
        paddleId,
        turn.reply,
        card ? "action" : "none",
        card ? JSON.stringify(card) : null,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cacheReadTokens,
        result.usage.cacheWriteTokens,
        result.tokensUsed,
        result.latencyMs,
        result.error,
      ],
    );
    const replyId = reply.rows[0]?.id;
    if (!replyId) throw new Error("no reply id");
    await appendTranscript(client, paddleId, result.transcriptAppend, { guestMessageId: guest.rows[0]?.id ?? null, glimMessageId: replyId });
    await insertRejections(client, result.rejections, null);
    await tellOtherTabs(client, replyId);
  });
  return null;
}

/** Every proposal or part of one code refused: 12's check reads these. */
async function insertRejections(db: Queryable, records: readonly GlimActionRecord[], planId: string | null): Promise<void> {
  // In lot-id order: each insert takes a key-share lock on its lot, and the engine locks lots in this order.
  for (const record of [...records].sort((a, b) => (a.lotId ?? "").localeCompare(b.lotId ?? ""))) {
    await db.query(
      `insert into glim_actions
         (paddle_id, plan_id, lot_id, kind, amount_cents, limit_cents, hold_cents_at_time, decision, reject_reason, message, chip)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        record.paddleId,
        planId ?? record.planId,
        record.lotId,
        record.kind,
        record.amountCents,
        record.limitCents,
        record.holdCentsAtTime,
        record.decision,
        record.rejectReason,
        record.message,
        record.chip,
      ],
    );
  }
}
