/**
 * The records every autopilot run leaves: one glim_autopilot_runs row whatever the outcome, the
 * proposal_rejected rows of a model decision that was set aside, and the "Deciding…" and finished
 * rows on the paddle's own channel (07's header reads them).
 */
import type { AutopilotDecider, AutopilotOutcome, AutopilotTrigger } from "@/server/glim/autopilot/types";
import type { GlimTokenUsage } from "@/server/glim/client";
import type { GlimActionRecord } from "@/server/glim/types";
import { appendEventLog, type JsonValue } from "@/server/sse/notify";

import type { Queryable } from "./db";

export interface RunRecord {
  id: string;
  paddleId: string;
  eventId: string;
  planId: string | null;
  actionId: string | null;
  triggers: readonly AutopilotTrigger[];
  outcome: AutopilotOutcome;
  decidedBy: AutopilotDecider;
  model: string | null;
  brief: string | null;
  error: string | null;
  decision: unknown;
  issues: unknown;
  planVersionBefore: number | null;
  planVersionAfter: number | null;
  latencyMs: number | null;
  usage: GlimTokenUsage | null;
  tokensUsed: number;
  startedAt: Date;
}

export async function insertRun(db: Queryable, run: RunRecord): Promise<void> {
  await db.query(
    `insert into glim_autopilot_runs
       (id, paddle_id, event_id, plan_id, action_id, triggers, outcome, decided_by, model, brief, error,
        decision, issues, plan_version_before, plan_version_after, latency_ms, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, tokens_used, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18,
        $19, $20, $21, $22, clock_timestamp())`,
    [
      run.id,
      run.paddleId,
      run.eventId,
      run.planId,
      run.actionId,
      JSON.stringify(run.triggers),
      run.outcome,
      run.decidedBy,
      run.model,
      run.brief,
      run.error,
      run.decision === null || run.decision === undefined ? null : JSON.stringify(run.decision),
      run.issues === null || run.issues === undefined ? null : JSON.stringify(run.issues),
      run.planVersionBefore,
      run.planVersionAfter,
      run.latencyMs,
      run.usage?.inputTokens ?? null,
      run.usage?.outputTokens ?? null,
      run.usage?.cacheReadTokens ?? null,
      run.usage?.cacheWriteTokens ?? null,
      run.tokensUsed,
      run.startedAt,
    ],
  );
}

/** A model decision that was rejected or adjusted, as evidence (§5.1), tagged with its run. */
export async function insertRejections(db: Queryable, records: readonly GlimActionRecord[], runId: string): Promise<void> {
  for (const record of records) {
    await db.query(
      `insert into glim_actions
         (paddle_id, plan_id, lot_id, kind, amount_cents, limit_cents, hold_cents_at_time, decision, reject_reason,
          message, chip, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        record.paddleId,
        record.planId,
        record.lotId,
        record.kind,
        record.amountCents,
        record.limitCents,
        record.holdCentsAtTime,
        record.decision,
        record.rejectReason,
        record.message,
        record.chip,
        JSON.stringify({ runId }),
      ],
    );
  }
}

type Connectable = { connect(): Promise<Queryable & { release(destroy?: boolean): void }> };
type RunEventPayload = { [key: string]: JsonValue };

/** One short transaction on a pooled client; a client whose rollback fails is discarded. */
async function inTransaction(pool: Connectable, work: (client: Queryable) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    await work(client);
    await client.query("commit");
  } catch (error) {
    broken = !(await client.query("rollback").then(
      () => true,
      () => false,
    ));
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Appends one row on the paddle's glim channel in its own short transaction: the event_log
 * ordering lock is transaction-scoped, so the insert must not run in autocommit.
 */
export async function appendRunEvent(pool: Connectable, entry: { eventId: string; paddleId: string; payload: RunEventPayload }): Promise<void> {
  await inTransaction(pool, async (client) => {
    await appendEventLog(client, [{ eventId: entry.eventId, paddleId: entry.paddleId, type: "glim", payload: entry.payload }]);
  });
}

/**
 * Records how a run that changed nothing ended: its glim_autopilot_runs row and, when it wrote a
 * "Deciding…" row, its autopilot_finished row, in one transaction, so the two never disagree.
 * (An applied change or a prepared raise writes both inside its own apply transaction.)
 */
export async function finishRun(pool: Connectable, run: RunRecord, finished: RunEventPayload | null): Promise<void> {
  await inTransaction(pool, async (client) => {
    await insertRun(client, run);
    if (finished) await appendEventLog(client, [{ eventId: run.eventId, paddleId: run.paddleId, type: "glim", payload: finished }]);
  });
}
