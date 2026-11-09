/**
 * Turns the engine's facts on a paddle's channel into glim_actions rows, chat_messages cards and a
 * chat_card row on the same channel, one transaction per paddle. It runs every tick (task.ts), right
 * after Start bidding and whenever the panel reads the chat, so a card is never more than a second late
 * and a process that does not tick still shows them.
 *
 * glim_actions.source_event_log_id makes this idempotent: a fact that already has its action writes
 * nothing, whoever got there first. A paddle's event_log ids are in commit order (src/server/sse/
 * notify.ts), so the newest fact with an action is a cursor: anything before it has been handled.
 *
 * Only real guests who have confirmed a plan get cards: Glim's limit facts exist only after that, and a
 * lot that closed before they ever used Glim is not Glim's news.
 */
import type pg from "pg";

import { getPool } from "@/server/db/client";
import { withTransaction, type Queryable } from "@/server/db/transaction";
import { sortedUnique } from "@/server/engine/ids";
import { appendEventLog, type EventLogEntry } from "@/server/sse/notify";

import { announcedByAutopilot, eventCardDraft, type AutopilotAnnouncement, type EventFactPayload } from "./event-cards";

/** Facts read in one pass; anything past it is read on the next. */
const SYNC_LIMIT = 200;

interface FactRow {
  id: string;
  event_id: string;
  paddle_id: string;
  payload: EventFactPayload;
  created_at: Date;
  transaction: string;
  timezone: string;
  short_title: string;
}

async function readFacts(db: Queryable, paddleId: string | null): Promise<FactRow[]> {
  const { rows } = await db.query<FactRow>(
    `select el.id::text as id, el.event_id, el.paddle_id, el.payload, el.created_at, el.created_at::text as transaction,
       e.timezone, l.short_title
     from (
       select g.paddle_id, min(g.confirmed_at) as first_confirmed_at
       from glim_plans g
       where g.confirmed_at is not null and ($1::uuid is null or g.paddle_id = $1::uuid)
       group by g.paddle_id
     ) started
     join paddles p on p.id = started.paddle_id and not p.is_simulated
     join events e on e.id = p.event_id
     join event_log el on el.paddle_id = p.id
       and el.id > coalesce((select max(a.source_event_log_id) from glim_actions a where a.paddle_id = p.id), 0)
       and (el.type = 'glim' or (el.type = 'lot_closed' and el.created_at >= started.first_confirmed_at))
       and el.payload->>'kind' in ('limit_raised', 'limit_exhausted', 'lot_won', 'lot_lost')
     join lots l on l.id = (el.payload->>'lotId')::uuid
     order by el.id
     limit $2`,
    [paddleId, SYNC_LIMIT],
  );
  return rows;
}

async function readAnnouncements(db: Queryable, paddleId: string): Promise<AutopilotAnnouncement[]> {
  const { rows } = await db.query<{ limit_ids: unknown; transaction: string }>(
    `select el.payload->'limitIds' as limit_ids, el.created_at::text as transaction
     from event_log el
     where el.paddle_id = $1 and el.type = 'glim' and el.payload->>'kind' = 'autopilot_finished' and el.payload ? 'limitIds'`,
    [paddleId],
  );
  return rows.map((row) => ({
    limitIds: Array.isArray(row.limit_ids) ? row.limit_ids.filter((id): id is string => typeof id === "string") : [],
    transaction: row.transaction,
  }));
}

/** Writes one paddle's cards; returns how many are new. */
async function writeCards(pool: pg.Pool, paddleId: string, facts: readonly FactRow[]): Promise<number> {
  const announcements = await readAnnouncements(pool, paddleId);
  return withTransaction(pool, async (client) => {
    // The rows below take key-share locks on the plan and on each lot through their foreign keys.
    // Taken up front in the order every writer locks them (the plan row, then lots in id order,
    // docs/planning/glim-autopilot.md §5.3), so this can't deadlock with a plan change or the engine.
    const plan = await client.query<{ id: string }>(
      "select id from glim_plans where paddle_id = $1 and status in ('active', 'paused') for key share",
      [paddleId],
    );
    const lotIds = sortedUnique(facts.map((row) => row.payload.lotId));
    await client.query("select id from lots where id = any($1) order by id for key share", [lotIds]);
    const hold = await client.query<{ amount_cents: number }>("select amount_cents from holds where paddle_id = $1 and status = 'authorized'", [paddleId]);
    const planId = plan.rows[0]?.id ?? null;
    const holdCents = hold.rows[0]?.amount_cents ?? null;
    const cards: EventLogEntry[] = [];
    for (const row of facts) {
      const fact = { id: row.id, payload: row.payload, createdAt: row.created_at, transaction: row.transaction };
      if (announcedByAutopilot(fact, announcements)) continue;
      const draft = eventCardDraft(fact, { timezone: row.timezone, shortTitle: row.short_title });
      if (!draft) continue;
      const { action, card } = draft;
      const inserted = await client.query<{ id: string }>(
        `insert into glim_actions
           (paddle_id, plan_id, lot_id, kind, amount_cents, limit_cents, hold_cents_at_time, decision, message, chip,
            trigger_bid_id, source_event_log_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'executed', $8, $9,
           (select id from bids where lot_id = $3 and amount_cents = $10), $11::bigint)
         on conflict (source_event_log_id) where source_event_log_id is not null do nothing
         returning id`,
        [paddleId, planId, action.lotId, action.kind, action.amountCents, action.limitCents, holdCents, action.message, action.chip, action.triggerAmountCents, row.id],
      );
      const actionId = inserted.rows[0]?.id;
      // Another writer got here first; its transaction wrote the card.
      if (!actionId) continue;
      const message = await client.query<{ id: string }>(
        `insert into chat_messages (paddle_id, role, text, card_type, card, plan_id)
         values ($1, 'glim', '', 'event', $2::jsonb, $3) returning id`,
        [paddleId, JSON.stringify({ ...card, actionId }), planId],
      );
      const chatMessageId = message.rows[0]?.id;
      if (!chatMessageId) throw new Error("no chat message id");
      cards.push({ eventId: row.event_id, paddleId, type: "glim", payload: { kind: "chat_card", chatMessageId, actionId } });
    }
    // The last write before commit: the event_log ordering lock is held from here on.
    await appendEventLog(client, cards);
    return cards.length;
  });
}

/** Posts every event card still owed, for one paddle or all of them; returns how many it wrote. */
export async function syncEventCards(input: { paddleId?: string; pool?: pg.Pool } = {}): Promise<number> {
  const pool = input.pool ?? getPool();
  const facts = await readFacts(pool, input.paddleId ?? null);
  const byPaddle = new Map<string, FactRow[]>();
  for (const fact of facts) byPaddle.set(fact.paddle_id, [...(byPaddle.get(fact.paddle_id) ?? []), fact]);
  let written = 0;
  for (const [paddleId, paddleFacts] of byPaddle) written += await writeCards(pool, paddleId, paddleFacts);
  return written;
}
