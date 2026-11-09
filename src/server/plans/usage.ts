/**
 * What Glim has spent: one token count for the day, shared by the chat and the autopilot
 * (docs/planning/glim-autopilot.md §7), and the counts the autopilot's caps read.
 */
import type { AutopilotUsageSoFar } from "@/server/glim/caps";
import { startOfTokenDay } from "@/server/glim/caps";

import type { Queryable } from "./db";

/**
 * Every token Glim processed since midnight UTC: chat replies and autopilot runs. The chat route
 * and autopilot both read this, so neither can spend the other's share twice.
 */
export async function tokensToday(db: Queryable, now: Date): Promise<number> {
  const since = startOfTokenDay(now);
  const { rows } = await db.query<{ total: string | number | null }>(
    `select
       coalesce((select sum(tokens_used) from chat_messages where created_at >= $1), 0)
       + coalesce((select sum(tokens_used) from glim_autopilot_runs where started_at >= $1), 0) as total`,
    [since],
  );
  return Number(rows[0]?.total ?? 0);
}

/** The model-call counts and the last call for this paddle and its event. */
export async function autopilotUsage(db: Queryable, paddleId: string, eventId: string, now: Date): Promise<AutopilotUsageSoFar> {
  const { rows } = await db.query<{ paddle_model: number; event_model: number; last_model_call_at: Date | null }>(
    `select
       (select count(*)::int from glim_autopilot_runs where paddle_id = $1 and model is not null) as paddle_model,
       (select count(*)::int from glim_autopilot_runs where event_id = $2 and model is not null) as event_model,
       (select last_model_call_at from glim_autopilot where paddle_id = $1) as last_model_call_at`,
    [paddleId, eventId],
  );
  const row = rows[0];
  return {
    paddleModelDecisions: row?.paddle_model ?? 0,
    eventModelDecisions: row?.event_model ?? 0,
    lastModelCallAt: row?.last_model_call_at ?? null,
    tokensToday: await tokensToday(db, now),
  };
}
