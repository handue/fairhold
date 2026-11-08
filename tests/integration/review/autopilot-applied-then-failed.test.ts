/**
 * Review finding (Nov 7, autopilot): runAutopilot's catch (src/server/plans/run.ts) treats any
 * error after the apply as a failed run, even when the apply already committed. If releaseClaim
 * fails once the change is applied (a dropped connection, a statement timeout), the run:
 *   - appends a second `autopilot_finished` row for the same runId, now with outcome `failed`,
 *     after the `applied` one that the apply transaction wrote (07's header and card read these);
 *   - throws, so the tick task requeues the claim, and the facts this run already acted on are
 *     processed again on the next attempt.
 * One fact should end in exactly one finished row and never be handled twice.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { DatabaseClient } from "@/server/db/client";
import { createAutopilotTickTask } from "@/server/plans/task";

import { getTestDatabase } from "../../helpers/database";
import { bid, createGala, heart, makeDue, recordedModel, rows, startBidding } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;

/** The test database, except that pool.query fails once for the statement containing `fragment`. */
function failingOnceOn(fragment: string): DatabaseClient {
  const real = database.pool;
  let failed = false;
  const query = (text: unknown, values?: unknown) => {
    if (!failed && typeof text === "string" && text.includes(fragment)) {
      failed = true;
      return Promise.reject(Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" }));
    }
    return (real.query as (text: unknown, values?: unknown) => Promise<pg.QueryResult>)(text, values);
  };
  const proxied = new Proxy(real, {
    get(target, property) {
      if (property === "query") return query;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...database, pool: proxied };
}

describe("a run whose change committed (review)", () => {
  it("finishes once, as applied, and never requeues the facts it acted on", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);

    // releaseClaim is the only statement that sets last_run_at.
    const task = createAutopilotTickTask({ database: failingOnceOn("last_run_at = now()"), model: recordedModel, onError: () => {} });
    await task.run();
    await makeDue(pool, gala.jamie);
    await task.run();
    await task.idle();

    // The golden move did commit.
    expect(await rows(pool, "select outcome from glim_autopilot_runs where paddle_id = $1", [gala.jamie])).toEqual([{ outcome: "applied" }]);
    const finished = await rows<{ outcome: string }>(
      pool,
      "select payload->>'outcome' as outcome from event_log where paddle_id = $1 and payload->>'kind' = 'autopilot_finished' order by id",
      [gala.jamie],
    );
    const [queued] = await rows<{ reasons: unknown[] }>(pool, "select reasons from glim_autopilot where paddle_id = $1", [gala.jamie]);
    expect({ finished, requeued: queued?.reasons }).toEqual({ finished: [{ outcome: "applied" }], requeued: [] });
  });
});
