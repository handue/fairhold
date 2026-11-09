/**
 * Review finding (Nov 7, autopilot): a run whose apply throws after the model answered leaves a
 * `failed` glim_autopilot_runs row built from `baseRun` (src/server/plans/run.ts, the catch in
 * runAutopilot), so it records model = null and tokens_used = 0. Those columns are the only input
 * of the autopilot caps (autopilotUsage and tokensToday in src/server/plans/usage.ts): the 12 model
 * decisions per paddle, the 150 per event and the 60% daily token share. A model call followed by a
 * lock timeout, a statement timeout or any other non-retried apply failure is therefore never
 * counted, and the requeued attempts can call the model again without the caps seeing it.
 *
 * The failure is injected as a statement timeout (57014) on the apply's plan version update.
 */
import type pg from "pg";
import { describe, expect, it } from "vitest";

import type { DatabaseClient } from "@/server/db/client";
import type { GlimModel } from "@/server/glim/client";
import { syntheticMessage } from "@/server/glim/recorded";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";
import { autopilotUsage } from "@/server/plans/usage";

import { getTestDatabase } from "../../helpers/database";
import { bid, createGala, heart, makeDue, rows, startBidding } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;

const GOLDEN_DECISION = JSON.stringify({
  action: "change",
  lots: [
    { lot_number: 12, priority: 2, max_dollars: null },
    { lot_number: 9, priority: 3, max_dollars: null },
  ],
  raise_to_dollars: null,
  reason: "top_lot_out_of_reach",
  why: "The dinner is past your budget now, so your money goes to the wine tasting you hearted.",
});

/** A live-mode model that bills 2,000 input and 400 output tokens for the golden decision. */
function billedModel(): GlimModel & { calls: number } {
  const model = {
    mode: "live" as const,
    calls: 0,
    async respond() {
      model.calls += 1;
      return syntheticMessage([{ type: "text", text: GOLDEN_DECISION, citations: null }], "end_turn", {
        usage: { input_tokens: 2_000, output_tokens: 400 },
      });
    },
  };
  return model;
}

/** The test database, except that one statement inside a pooled transaction fails with `code`. */
function failingOn(fragment: string, code: string): DatabaseClient {
  const real = database.pool;
  const connect = async () => {
    const client = await real.connect();
    const original = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>;
    const release = client.release.bind(client);
    Object.assign(client, {
      query: (text: string, values?: unknown[]) =>
        typeof text === "string" && text.includes(fragment)
          ? Promise.reject(Object.assign(new Error("canceling statement due to statement timeout"), { code }))
          : original(text, values),
      release: (destroy?: boolean) => {
        Object.assign(client, { query: original, release });
        release(destroy);
      },
    });
    return client;
  };
  const proxied = new Proxy(real, {
    get(target, property) {
      if (property === "connect") return connect;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { ...database, pool: proxied };
}

describe("a model call whose apply then fails (review)", () => {
  it("still counts toward the autopilot's model and token caps", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("not due");

    const before = await autopilotUsage(pool, gala.jamie, gala.eventId, new Date());
    expect(before).toMatchObject({ paddleModelDecisions: 0, eventModelDecisions: 0, tokensToday: 0 });

    const model = billedModel();
    await expect(
      runAutopilot(claim, { database: failingOn("update glim_plans set version", "57014"), model }),
    ).rejects.toThrow(/statement timeout/);
    // The model was asked and billed 2,400 tokens before the apply failed.
    expect(model.calls).toBe(1);
    expect(await rows(pool, "select outcome from glim_autopilot_runs where paddle_id = $1", [gala.jamie])).toEqual([
      { outcome: "failed" },
    ]);

    const after = await autopilotUsage(pool, gala.jamie, gala.eventId, new Date());
    expect(after.paddleModelDecisions).toBe(1);
    expect(after.eventModelDecisions).toBe(1);
    expect(after.tokensToday).toBe(2_400);
  });
});
