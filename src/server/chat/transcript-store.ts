/**
 * glim_transcript: Glim's conversation exactly as it went to the API, one row per message, read and
 * appended verbatim. Rows are never updated or deleted (src/server/glim/transcript.ts says why).
 * Callers hold the paddle's turn lock (lock.ts); the primary key is the backstop against a fork.
 */
import type { Queryable } from "@/server/db/transaction";
import type { GlimTranscript, TranscriptMessage } from "@/server/glim/transcript";

export async function loadTranscript(db: Queryable, paddleId: string): Promise<GlimTranscript> {
  const { rows } = await db.query<{ message: TranscriptMessage }>(
    "select message from glim_transcript where paddle_id = $1 order by position",
    [paddleId],
  );
  return rows.map((row) => row.message);
}

/** Appends in order; each row points at the chat message its role belongs to. */
export async function appendTranscript(
  db: Queryable,
  paddleId: string,
  messages: readonly TranscriptMessage[],
  links: { guestMessageId: string | null; glimMessageId: string | null },
): Promise<void> {
  if (messages.length === 0) return;
  const { rows } = await db.query<{ next: number }>(
    "select coalesce(max(position), -1) + 1 as next from glim_transcript where paddle_id = $1",
    [paddleId],
  );
  let position = rows[0]?.next ?? 0;
  for (const message of messages) {
    await db.query("insert into glim_transcript (paddle_id, position, message, chat_message_id) values ($1, $2, $3::jsonb, $4)", [
      paddleId,
      position,
      JSON.stringify(message),
      message.role === "assistant" ? links.glimMessageId : links.guestMessageId,
    ]);
    position += 1;
  }
}
