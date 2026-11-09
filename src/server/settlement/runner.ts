/**
 * Who makes the queue move: routes kick it so a charge starts at once, and the engine tick keeps
 * kicking it, which is what brings back an item after a restart or a backoff. Nothing here waits:
 * the tick runs its tasks one after another, and a PayPal call must never delay lot closing.
 *
 * Kept on globalThis because Next.js gives each route its own module copies. One drain per process;
 * two processes during a deploy are fine, because claims skip locked rows.
 */
import type { TickTask } from "@/server/engine/tick";

import { processSettlementQueue } from "./queue";
import { processWebhookEvents, type ProcessWebhooksOptions } from "./webhook";

interface RunnerState {
  drain: Promise<void> | null;
  again: boolean;
  webhooks: Set<Promise<unknown>>;
}

const processGlobal = globalThis as typeof globalThis & { __fairholdSettlementRunner?: RunnerState };

function runnerState(): RunnerState {
  processGlobal.__fairholdSettlementRunner ??= { drain: null, again: false, webhooks: new Set() };
  return processGlobal.__fairholdSettlementRunner;
}

/** Starts working through the queue unless this process already is; then it looks once more after. */
export function kickSettlementQueue(): void {
  const state = runnerState();
  if (state.drain) {
    state.again = true;
    return;
  }
  const run = async () => {
    do {
      state.again = false;
      await processSettlementQueue();
    } while (state.again);
  };
  state.drain = run()
    .catch((error: unknown) => console.error("[settlement] the queue stopped:", error))
    .finally(() => {
      state.drain = null;
    });
}

/** Applies stored webhook events without making PayPal's delivery wait for it. */
export function kickWebhookProcessing(options: ProcessWebhooksOptions = {}): void {
  const { webhooks } = runnerState();
  const job: Promise<unknown> = processWebhookEvents(options, { afterRequeue: kickSettlementQueue })
    .catch((error: unknown) => console.error("[paypal/webhook] applying events failed:", error))
    .finally(() => webhooks.delete(job));
  webhooks.add(job);
}

/** Resolves once the work started so far has finished (tests, shutdown). */
export async function settlementRunnerIdle(): Promise<void> {
  const state = runnerState();
  while (state.drain || state.webhooks.size > 0) {
    await Promise.all([state.drain, ...state.webhooks]);
  }
}

/** A failed webhook row waits this long for its next try. */
const WEBHOOK_RETRY_MS = 60_000;
/** The route that stored a row applies it; the tick takes what that left behind. */
const WEBHOOK_LEFTOVER_SECONDS = 10;

/** One engine tick task (register it in src/instrumentation.ts with startEngineTick). */
export function createSettlementTickTask(): TickTask {
  let lastRetry = 0;
  return {
    name: "settlement",
    async run() {
      kickSettlementQueue();
      if (runnerState().webhooks.size > 0) return;
      const retryFailed = Date.now() - lastRetry >= WEBHOOK_RETRY_MS;
      if (retryFailed) lastRetry = Date.now();
      kickWebhookProcessing({ retryFailed, olderThanSeconds: WEBHOOK_LEFTOVER_SECONDS });
    },
  };
}
