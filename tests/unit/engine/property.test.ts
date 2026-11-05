import fc from "fast-check";
import { describe, it } from "vitest";

import { createMemoryWorld, propertyRuns, runScenario, scenarioArbitrary } from "./support/auction-model";

/*
 * Random sequences of bids, maxes, plans, limit edits, pauses, hold raises, expiries, ticks and
 * event closes, through the real engine actions on the in-memory store. After every command:
 * no paddle commits more than its hold, no bid lands at or after its lot's close, every closed
 * lot's winner is its highest accepted bid, and a refused command changes nothing.
 * FAST_CHECK_RUNS raises the run count (CI runs more).
 */
describe("engine properties", () => {
  it("keeps every invariant across random command sequences", { timeout: 600_000 }, async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async ({ config, commands }) => {
        await runScenario(createMemoryWorld(config), commands);
      }),
      { numRuns: propertyRuns(2_000) },
    );
  });
});
