/**
 * The director as one engine tick task. A round queues any new reactions and starts workers for the
 * due jobs without awaiting them: the tick runs its tasks one after another, and a job waiting on a
 * lot lock must never delay lot closing. An idle round costs three small queries. Only the process
 * holding the tick's lock runs this, and a job's bid commits with its "done", so a restart in the
 * middle of a round neither loses a job nor repeats one.
 */
import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import type { TickTask } from "@/server/engine/tick";

import { scheduleReactions } from "./reactions";
import { dueJobCount, runNextJob } from "./run";

/** Connections the director may hold at once; the web process shares its pool of 10. */
const MAX_WORKERS = 3;
/** A worker gives its connection back after this many jobs; the next round starts another. */
const JOBS_PER_WORKER = 5;

export interface DirectorTickTaskOptions {
  database?: DatabaseClient;
  maxWorkers?: number;
  onError?: (error: unknown, context: string) => void;
}

export interface DirectorTickTask extends TickTask {
  /** Resolves once every worker started so far has finished (tests, shutdown). */
  idle(): Promise<void>;
}

export function createDirectorTickTask(options: DirectorTickTaskOptions = {}): DirectorTickTask {
  const running = new Set<Promise<void>>();
  const maxWorkers = options.maxWorkers ?? MAX_WORKERS;
  const onError = options.onError ?? ((error, context) => console.error(`[director] ${context}:`, error));
  const database = () => options.database ?? getDatabaseClient();

  const work = async (): Promise<void> => {
    const { pool } = database();
    for (let done = 0; done < JOBS_PER_WORKER; done += 1) {
      if (!(await runNextJob({ pool }))) return;
    }
  };

  return {
    name: "director",
    async run() {
      const { pool } = database();
      await scheduleReactions(pool);
      const free = maxWorkers - running.size;
      if (free <= 0) return;
      const due = await dueJobCount(pool, free);
      for (let started = 0; started < due; started += 1) {
        const worker: Promise<void> = work()
          .catch((error: unknown) => onError(error, "worker"))
          .finally(() => running.delete(worker));
        running.add(worker);
      }
    },
    async idle() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
}
