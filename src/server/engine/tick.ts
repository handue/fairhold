import pg from "pg";

import { getDatabaseUrl } from "@/server/lib/env";

import { closeDueLots } from "./closing";
import { ENGINE_TICK_LOCK } from "./locks";

/** One unit of the engine's periodic work. Later days add bots, the settlement queue and nudges. */
export interface TickTask {
  name: string;
  run(): Promise<unknown>;
}

export interface EngineTickOptions {
  /** Time between the starts of two rounds. Defaults to one second. */
  intervalMs?: number;
  /** For the dedicated lock connection. Defaults to DATABASE_URL. */
  connectionString?: string;
  tasks?: readonly TickTask[];
  onError?: (error: unknown, context: string) => void;
}

export interface EngineTick {
  /** Whether this process currently holds the tick lock and runs the tasks. */
  readonly isLeader: boolean;
  /** Stops scheduling, waits for the round in progress, and releases the lock. */
  stop(): Promise<void>;
}

export const DEFAULT_TICK_TASKS: readonly TickTask[] = [{ name: "closeDueLots", run: () => closeDueLots() }];

/** After repeated failures (database down), rounds back off up to this long. */
const MAX_BACKOFF_MS = 30_000;

/**
 * Runs the tasks every interval in whichever process holds a session-level advisory lock, taken
 * on a dedicated connection. When Render's deploys overlap, the old process keeps ticking until
 * its connection closes, then the new one takes over; only one process ticks at a time.
 */
export function createEngineTick(options: EngineTickOptions = {}): EngineTick {
  const tick = new TickRunner(options);
  tick.start();
  return tick;
}

const processGlobal = globalThis as typeof globalThis & { __fairholdEngineTick?: EngineTick };

/**
 * The process-wide tick, started at most once per process (instrumentation.ts calls this).
 * `extraTasks` run after the default ones in each round, such as Glim's autopilot.
 */
export function startEngineTick(extraTasks: readonly TickTask[] = []): EngineTick {
  processGlobal.__fairholdEngineTick ??= createEngineTick({ tasks: [...DEFAULT_TICK_TASKS, ...extraTasks] });
  return processGlobal.__fairholdEngineTick;
}

class TickRunner implements EngineTick {
  private readonly intervalMs: number;
  private readonly connectionString: string;
  private readonly tasks: readonly TickTask[];
  private readonly onError: (error: unknown, context: string) => void;
  private lockClient: pg.Client | null = null;
  private leader = false;
  private stopped = false;
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private round: Promise<void> | null = null;

  constructor(options: EngineTickOptions) {
    this.intervalMs = options.intervalMs ?? 1_000;
    this.connectionString = options.connectionString ?? getDatabaseUrl();
    this.tasks = options.tasks ?? DEFAULT_TICK_TASKS;
    this.onError = options.onError ?? ((error, context) => console.error(`[engine tick] ${context}:`, error));
  }

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.round;
    await this.closeLockConnection();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const startedAt = Date.now();
      this.round = this.runRound().finally(() => {
        this.round = null;
        const backoffMs = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.consecutiveFailures);
        this.schedule(Math.max(0, backoffMs - (Date.now() - startedAt)));
      });
    }, delayMs);
  }

  private async runRound(): Promise<void> {
    try {
      if (!(await this.holdLeadership())) return;
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.onError(error, "lock connection");
      await this.closeLockConnection();
      return;
    }
    for (const task of this.tasks) {
      if (this.stopped) return;
      try {
        await task.run();
      } catch (error) {
        this.onError(error, task.name);
      }
    }
  }

  /** Takes the lock if it is free; when already held, confirms this session still holds it. */
  private async holdLeadership(): Promise<boolean> {
    const client = this.lockClient ?? (await this.openLockConnection());
    const { namespace, key } = ENGINE_TICK_LOCK;
    if (this.leader) {
      const { rowCount } = await client.query(
        `select 1 from pg_locks
         where locktype = 'advisory' and classid = $1 and objid = $2 and objsubid = 2
           and pid = pg_backend_pid() and granted`,
        [namespace, key],
      );
      this.leader = rowCount === 1;
      if (this.leader) return true;
    }
    const { rows } = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock($1, $2) as acquired",
      [namespace, key],
    );
    this.leader = rows[0]?.acquired === true;
    return this.leader;
  }

  private async openLockConnection(): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: this.connectionString, keepAlive: true });
    // A dead connection has already released the lock; drop it and reconnect next round.
    client.on("error", (error) => {
      this.onError(error, "lock connection");
      if (this.lockClient === client) {
        this.lockClient = null;
        this.leader = false;
      }
    });
    await client.connect();
    this.lockClient = client;
    this.leader = false;
    return client;
  }

  private async closeLockConnection(): Promise<void> {
    const client = this.lockClient;
    this.lockClient = null;
    this.leader = false;
    // Ending the session releases its advisory locks.
    await client?.end().catch(() => {});
  }
}
