/**
 * One token count for the day (docs/planning/glim-autopilot.md §7): chat replies and autopilot
 * runs since midnight UTC, the figure both the chat's cap and the autopilot's 60% share read.
 */
import { describe, expect, it } from "vitest";

import { startOfTokenDay } from "@/server/glim/caps";
import { autopilotUsage, tokensToday } from "@/server/plans/usage";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

describe("tokensToday", () => {
  it("sums chat replies and autopilot runs since midnight UTC", async () => {
    const eventId = await createEvent(pool);
    const paddleId = await createPaddle(pool, eventId, 142);
    const { rows } = await pool.query<{ now: Date }>("select now() as now");
    const now = rows[0]?.now ?? new Date();
    const yesterday = new Date(startOfTokenDay(now).getTime() - 60_000);
    for (const [tokens, at] of [
      [1_200, now],
      [800, now],
      [5_000, yesterday],
    ] as const) {
      await pool.query("insert into chat_messages (paddle_id, role, text, tokens_used, created_at) values ($1, 'glim', 'x', $2, $3)", [
        paddleId,
        tokens,
        at,
      ]);
    }
    for (const [tokens, at, model] of [
      [2_500, now, "claude-opus-5-5"],
      [0, now, null],
      [9_000, yesterday, "claude-opus-5-5"],
    ] as const) {
      await pool.query(
        `insert into glim_autopilot_runs (id, paddle_id, event_id, triggers, outcome, decided_by, model, tokens_used, started_at)
         values (gen_random_uuid(), $1, $2, '[]'::jsonb, 'kept', 'model', $3, $4, $5)`,
        [paddleId, eventId, model, tokens, at],
      );
    }
    expect(await tokensToday(pool, now)).toBe(1_200 + 800 + 2_500);
    expect(await autopilotUsage(pool, paddleId, eventId, now)).toEqual({
      paddleModelDecisions: 2,
      eventModelDecisions: 2,
      lastModelCallAt: null,
      tokensToday: 4_500,
    });
  });
});
