/** The counts behind the caps: guest messages from chat_messages, and the one daily token count. */
import type { Queryable } from "@/server/db/transaction";
import type { GlimUsageSoFar } from "@/server/glim/caps";
import { tokensToday } from "@/server/plans/usage";

export async function chatUsageSoFar(db: Queryable, input: { paddleId: string; eventId: string }): Promise<GlimUsageSoFar> {
  const { rows } = await db.query<{ paddle_messages: number; event_messages: number; now: Date }>(
    `select
       (select count(*)::int from chat_messages where paddle_id = $1 and role = 'guest') as paddle_messages,
       (select count(*)::int from chat_messages m join paddles p on p.id = m.paddle_id
        where p.event_id = $2 and m.role = 'guest') as event_messages,
       now() as now`,
    [input.paddleId, input.eventId],
  );
  const row = rows[0];
  return {
    paddleMessages: row?.paddle_messages ?? 0,
    eventMessages: row?.event_messages ?? 0,
    tokensToday: await tokensToday(db, row?.now ?? new Date()),
  };
}
