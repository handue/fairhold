/**
 * One turn at a time per paddle. A turn reads the transcript, calls the model and appends to the
 * transcript, so two at once would fork the conversation (glim_transcript's primary key would refuse
 * the second only after its model call was paid for). A second message waits here, then runs on the
 * transcript the first one left.
 *
 * The lock is a session-level Postgres advisory lock on a connection of its own, outside the pool: a
 * turn holds it for the seconds a model call takes while its own reads use the pool, and if the
 * process dies the connection goes and the lock with it. Namespace 0x4648_0005 (see engine/locks.ts).
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { openListenConnection } from "@/server/db/client";

const TURN_LOCK_NAMESPACE = 0x4648_0005;

/** Longer than one whole turn (TURN_TIMEOUT_MS), so a message waits out the one before it. */
export const TURN_WAIT_MS = 75_000;
/** A turn's model call is given up on after this; the guest gets the fallback line. */
export const TURN_TIMEOUT_MS = 60_000;
/** Connections this process may hold for turns, so a burst cannot use up the database's. */
const MAX_OPEN_TURNS = 16;
/**
 * The turn running and one waiting for it. A guest's further messages are answered at once, so one
 * guest sending many cannot take the connections every other guest's turn needs.
 */
const MAX_OPEN_TURNS_PER_PADDLE = 2;

const LOCK_NOT_AVAILABLE = "55P03";

interface OpenTurns {
  total: number;
  perPaddle: Map<string, number>;
}

const processGlobal = globalThis as typeof globalThis & { __fairholdOpenGlimTurns?: OpenTurns };

const openTurns = (): OpenTurns => (processGlobal.__fairholdOpenGlimTurns ??= { total: 0, perPaddle: new Map() });

const busy = () =>
  new ApiError(409, "glim_busy", "I’m still answering your last message. Try again in a moment.");

export interface TurnLock {
  release(): Promise<void>;
}

export interface TurnLockOptions {
  waitMs?: number;
  connectionString?: string;
}

/**
 * Waits for this paddle's turn; throws a 409 glim_busy after waitMs, or at once when this paddle
 * already has a message waiting or the process is full. The caller must release it.
 */
export async function acquireTurnLock(paddleId: string, options: TurnLockOptions = {}): Promise<TurnLock> {
  const turns = openTurns();
  const mine = turns.perPaddle.get(paddleId) ?? 0;
  if (mine >= MAX_OPEN_TURNS_PER_PADDLE || turns.total >= MAX_OPEN_TURNS) throw busy();
  turns.total += 1;
  turns.perPaddle.set(paddleId, mine + 1);

  let client: pg.Client | null = null;
  const letGo = async () => {
    turns.total = Math.max(0, turns.total - 1);
    const left = (turns.perPaddle.get(paddleId) ?? 1) - 1;
    if (left > 0) turns.perPaddle.set(paddleId, left);
    else turns.perPaddle.delete(paddleId);
    // Ending the session releases its advisory lock.
    await client?.end().catch(() => {});
  };
  try {
    client = await openListenConnection(options.connectionString);
    // A lost connection has already released the lock; the transcript's primary key is the backstop.
    client.on("error", (error) => console.error("[glim chat] turn lock connection:", error.message));
    await client.query("select set_config('lock_timeout', $1, false)", [`${options.waitMs ?? TURN_WAIT_MS}ms`]);
    await client.query("select pg_advisory_lock($1, hashtext($2))", [TURN_LOCK_NAMESPACE, paddleId]);
  } catch (error) {
    await letGo();
    if ((error as { code?: unknown }).code === LOCK_NOT_AVAILABLE) throw busy();
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await letGo();
    },
  };
}

export async function withTurnLock<T>(paddleId: string, work: () => Promise<T>, options?: TurnLockOptions): Promise<T> {
  const lock = await acquireTurnLock(paddleId, options);
  try {
    return await work();
  } finally {
    await lock.release();
  }
}
