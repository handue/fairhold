/**
 * Glim's autopilot as one engine tick task (docs/planning/glim-autopilot.md §3.3). Each round it
 * scans new facts and closing lots, claims due paddles and starts their runs without awaiting
 * them: the tick runs its tasks one after another, so a model call here must never delay lot
 * closing. At most four runs per process, one per paddle (the claim's lease).
 */
import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import type { TickTask } from "@/server/engine/tick";
import { AUTOPILOT_CAPS } from "@/server/glim/caps";
import type { GlimModel } from "@/server/glim/client";

import { runAutopilot } from "./run";
import { claimDue, requeueClaim, scanClosingSoon, scanFacts, type AutopilotClaim } from "./scan";

/** After a run throws, its reasons come back this much later. */
const RETRY_DELAY_MS = 5_000;

export interface AutopilotTickTaskOptions {
  database?: DatabaseClient;
  model?: GlimModel;
  maxConcurrent?: number;
  onError?: (error: unknown, context: string) => void;
}

export interface AutopilotTickTask extends TickTask {
  /** Resolves once every run started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
}

export function createAutopilotTickTask(options: AutopilotTickTaskOptions = {}): AutopilotTickTask {
  const running = new Set<Promise<void>>();
  const maxConcurrent = options.maxConcurrent ?? AUTOPILOT_CAPS.concurrentRuns;
  const onError = options.onError ?? ((error, context) => console.error(`[glim autopilot] ${context}:`, error));
  const database = () => options.database ?? getDatabaseClient();

  const runClaim = async (claim: AutopilotClaim): Promise<void> => {
    try {
      // A run throws only when nothing recorded its outcome; after that it handles its own errors.
      await runAutopilot(claim, { database: database(), model: options.model, onError });
    } catch (error) {
      onError(error, `run for paddle ${claim.paddleId}`);
      try {
        await requeueClaim(database().pool, claim, { delayMs: RETRY_DELAY_MS, countAttempt: true, error });
      } catch (requeueError) {
        // The lease expires in a minute and the reasons are reclaimed then.
        onError(requeueError, `requeue for paddle ${claim.paddleId}`);
      }
    }
  };

  return {
    name: "glimAutopilot",
    async run() {
      const { pool } = database();
      await scanFacts(pool);
      await scanClosingSoon(pool);
      const free = maxConcurrent - running.size;
      if (free <= 0) return;
      for (const claim of await claimDue(pool, { limit: free })) {
        const job: Promise<void> = runClaim(claim).finally(() => running.delete(job));
        running.add(job);
      }
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
