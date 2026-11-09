/** The wave 2 schema changes the tracks rely on. */
import { describe, expect, it } from "vitest";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

async function guest(): Promise<{ eventId: string; paddleId: string }> {
  const eventId = await createEvent(pool);
  return { eventId, paddleId: await createPaddle(pool, eventId, 142) };
}

describe("glim_actions.source_event_log_id", () => {
  async function logRow(eventId: string, paddleId: string): Promise<number> {
    const { rows } = await pool.query<{ id: string }>(
      `insert into event_log (event_id, paddle_id, type, payload) values ($1, $2, 'glim', '{}') returning id`,
      [eventId, paddleId],
    );
    return Number(rows[0]?.id);
  }

  const insertAction = (paddleId: string, source: number | null) =>
    pool.query(
      `insert into glim_actions (paddle_id, kind, decision, message, source_event_log_id)
       values ($1, 'raise', 'executed', 'Someone bid $360.', $2)
       on conflict (source_event_log_id) where source_event_log_id is not null do nothing`,
      [paddleId, source],
    );

  it("makes turning an engine fact into its action idempotent", async () => {
    const { eventId, paddleId } = await guest();
    const fact = await logRow(eventId, paddleId);
    expect((await insertAction(paddleId, fact)).rowCount).toBe(1);
    expect((await insertAction(paddleId, fact)).rowCount).toBe(0);
  });

  it("leaves actions with no source free to repeat", async () => {
    const { paddleId } = await guest();
    expect((await insertAction(paddleId, null)).rowCount).toBe(1);
    expect((await insertAction(paddleId, null)).rowCount).toBe(1);
  });
});

describe("created_at on chat_messages and glim_actions", () => {
  it("keeps rows written in one transaction in the order they were written", async () => {
    const { paddleId } = await guest();
    const client = await pool.connect();
    try {
      await client.query("begin");
      for (const text of ["first", "second", "third"]) {
        await client.query("insert into chat_messages (paddle_id, role, text) values ($1, 'glim', $2)", [paddleId, text]);
        await client.query("insert into glim_actions (paddle_id, kind, decision, message) values ($1, 'raise', 'executed', $2)", [paddleId, text]);
      }
      await client.query("commit");
    } finally {
      client.release();
    }
    const chat = await pool.query<{ text: string }>("select text from chat_messages where paddle_id = $1 order by created_at", [paddleId]);
    expect(chat.rows.map((row) => row.text)).toEqual(["first", "second", "third"]);
    const actions = await pool.query<{ message: string }>("select message from glim_actions where paddle_id = $1 order by created_at", [paddleId]);
    expect(actions.rows.map((row) => row.message)).toEqual(["first", "second", "third"]);
  });
});

describe("heartbeats", () => {
  it("keeps one row per job, with its latest beat", async () => {
    const beat = () =>
      pool.query(
        `insert into heartbeats (name, detail) values ('sweep', '{"voided":1}')
         on conflict (name) do update set beat_at = now(), detail = excluded.detail`,
      );
    await beat();
    await beat();
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from heartbeats where name = 'sweep'");
    expect(rows[0]?.n).toBe(1);
  });
});
