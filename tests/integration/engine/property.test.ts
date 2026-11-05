import fc from "fast-check";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { getTestDatabase } from "../../helpers/database";
import {
  createMemoryWorld,
  propertyRuns,
  runScenario,
  scenarioArbitrary,
} from "../../unit/engine/support/auction-model";

import { createPgWorld } from "./support/pg-world";

const { url } = getTestDatabase();
// Thousands of tiny transactions: skipping the commit flush makes them several times faster and
// changes nothing the engine can observe.
const pool = new pg.Pool({ connectionString: url, max: 2, options: "-c synchronous_commit=off" });

afterAll(async () => {
  await pool.end();
});

/*
 * The unit property test proves the rules on the in-memory store at 2,000 runs. This one runs
 * the same random scenarios on Postgres, checks every invariant after each command there too,
 * and requires Postgres and the in-memory model to agree on every outcome and on the final
 * state: the SQL store implements exactly the semantics the unit runs verified. A Postgres run
 * costs about a thousand times a memory run, so it defaults to a tenth of FAST_CHECK_RUNS.
 */
describe("engine properties on Postgres", () => {
  it("matches the in-memory model command for command", { timeout: 900_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ config, commands }) => {
        const memory = createMemoryWorld(config);
        const postgres = await createPgWorld(pool, config);
        const expected = await runScenario(memory, commands);
        const actual = await runScenario(postgres, commands);
        expect(actual).toEqual(expected);
        expect(await postgres.view()).toEqual(await memory.view());
      }),
      { numRuns: Math.ceil(propertyRuns(2_000) / 10) },
    );
  });
});
