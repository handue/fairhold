/**
 * One autopilot run for one claimed paddle (docs/planning/glim-autopilot.md §3-§6): a fresh read,
 * the gate, the decision (options, then the model or the rule), and the apply through the one
 * plan writer. Every run leaves a glim_autopilot_runs row; only an applied change or a prepared
 * raise posts a card. An engine refusal caused by a rival bid or a close landing in between is
 * retried once on a fresh read with the same decision, which carries no amounts.
 */
import { randomUUID } from "node:crypto";

import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import {
  autopilotCard,
  changeLines,
  raiseLines,
  autopilotRaiseCard,
  templateWhy,
  type AppliedFacts,
} from "@/server/glim/autopilot/copy";
import { decideAutopilot, type AutopilotDecisionResult } from "@/server/glim/autopilot/decide";
import { decisionToJson } from "@/server/glim/autopilot/schema";
import {
  primaryTrigger,
  type AutopilotChange,
  type AutopilotContext,
  type AutopilotDecider,
  type AutopilotOutcome,
} from "@/server/glim/autopilot/types";
import { checkDecision } from "@/server/glim/autopilot/validate";
import { AUTOPILOT_CAPS, checkAutopilotModel } from "@/server/glim/caps";
import { getGlimModel, type GlimModel } from "@/server/glim/client";
import { getGlimConfig } from "@/server/glim/config";

import {
  applyAutopilotChange,
  prepareAutopilotRaise,
  PENDING_CARD_SECONDS,
  RAISE_PENDING_SECONDS,
  type ApplyAutopilotResult,
  type AutopilotRecordDraft,
} from "./apply";
import { loadAutopilotRead, type AutopilotRead } from "./context";
import { logError } from "./db";
import { appendRunEvent, finishRun, insertRejections, insertRun, type RunRecord } from "./runs";
import { releaseClaim, requeueClaim, type AutopilotClaim } from "./scan";

/** Engine refusals a rival bid or a close between the read and the locks can cause (§5.2). */
const RETRIED_REFUSALS: ReadonlySet<string> = new Set(["below_minimum", "lot_closed"]);

export type AutopilotGate =
  | { run: true; context: AutopilotContext }
  | { run: false; outcome: "skipped" | "stopped"; reason: string; retryAt: Date | null };

/** §3.4, on the run's fresh read. */
export function autopilotGate(read: AutopilotRead): AutopilotGate {
  const skip = (reason: string, retryAt: Date | null = null): AutopilotGate => ({ run: false, outcome: "skipped", reason, retryAt });
  if (read.isSimulated) return skip("simulated_paddle");
  if (read.eventStatus !== "live") return skip("event_not_live");
  if (!read.plan || read.plan.status !== "active") return skip("plan_not_active");
  if (!read.plan.mandate) return skip("no_mandate");
  if (read.holdCents === null) return skip("no_hold");
  if (read.pendingCardAt) {
    // Reconsidered once the card is two minutes old, unless the guest confirms it first.
    return skip("pending_card", new Date(read.pendingCardAt.getTime() + PENDING_CARD_SECONDS * 1000 + 1000));
  }
  if (read.appliedChanges >= AUTOPILOT_CAPS.appliedChangesPerPaddle) {
    return { run: false, outcome: "stopped", reason: "applied_changes_cap", retryAt: null };
  }
  if (!read.context) return skip("no_context");
  return { run: true, context: read.context };
}

export interface RunAutopilotOptions {
  database?: DatabaseClient;
  model?: GlimModel;
  dailyTokenBudget?: number;
  signal?: AbortSignal;
  /** Failures the run handles itself, such as a lost release after its outcome was recorded. */
  onError?: (error: unknown, context: string) => void;
}

const logToConsole = (error: unknown, context: string): void => console.error(`[glim autopilot] ${context}:`, error);

export interface RunReport {
  runId: string;
  outcome: AutopilotOutcome;
  decidedBy: AutopilotDecider;
  reason: string | null;
  actionId: string | null;
  chatMessageId: string | null;
  decision: AutopilotDecisionResult | null;
}

/** "Deciding…": a row on the paddle's channel and last_model_call_at, right before the model call. */
async function markDeciding(database: DatabaseClient, eventId: string, paddleId: string, runId: string): Promise<void> {
  await database.pool.query("update glim_autopilot set last_model_call_at = now() where paddle_id = $1", [paddleId]);
  await appendRunEvent(database.pool, { eventId, paddleId, payload: { kind: "autopilot_deciding", runId } });
}

function usesModelWhy(decision: AutopilotDecisionResult): string | null {
  return decision.decidedBy === "model" ? decision.modelWhy : null;
}

function describeChange(runId: string, context: AutopilotContext, decision: AutopilotDecisionResult, change: AutopilotChange) {
  return (applied: AppliedFacts, ids: { actionId: string; chatMessageId: string }): AutopilotRecordDraft => {
    const trigger = primaryTrigger(context.triggers);
    const lines = changeLines({ change, context, applied, trigger });
    const added = change.after.some((lot) => !change.before.some((before) => before.lotId === lot.lotId));
    const modelWhy = usesModelWhy(decision);
    const why =
      modelWhy ??
      templateWhy({
        context,
        decidedBy: decision.decidedBy,
        reason: decision.reason,
        mainLotId: lines.mainLotId,
        priorityCall: lines.priorityCall,
        topUp: !added,
        trigger,
      });
    const whySource = modelWhy ? "model" : "template";
    const main = change.after.find((lot) => lot.lotId === lines.mainLotId);
    return {
      action: {
        lotId: lines.mainLotId,
        amountCents: main?.maxCents ?? null,
        limitCents: main?.maxCents ?? null,
        chip: lines.chip ? "winning" : "none",
        message: lines.whatLine,
        detail: {
          runId,
          triggers: context.triggers,
          before: change.before,
          after: change.after.map((lot) => ({ lotId: lot.lotId, lotNumber: lot.lotNumber, priority: lot.priority, maxCents: lot.maxCents })),
          decidedBy: decision.decidedBy,
          why,
          whySource,
          reason: decision.reason,
          bidIds: applied.bids.filter((bid) => bid.paddleId === applied.paddleId && bid.source === "glim").map((bid) => bid.id),
          adjusted: decision.adjusted,
          amountsCents: lines.amountsCents,
          // V4: 10's feed row shows the card's chip, "Winning · $220": the bid, not the new maximum.
          chipCents: lines.chip?.amountCents ?? null,
        },
      },
      card: { ...autopilotCard({ runId, actionId: ids.actionId, context, lines, change, why, whySource }) },
    };
  };
}

/**
 * Lets go of a claim whose outcome is recorded: releases it, which clears its claimed reasons, or
 * puts them back for later when the gate asked for that. The facts are handled by then, so a
 * failure here must never run them again as a failed run would: it is retried once, then logged,
 * and the 60-second lease takes over (the plan version keeps a reclaimed fact from applying twice).
 */
async function settleClaim(
  pool: DatabaseClient["pool"],
  claim: AutopilotClaim,
  onError: NonNullable<RunAutopilotOptions["onError"]>,
  requeueAfterMs: number | null = null,
): Promise<void> {
  const settle = () =>
    requeueAfterMs === null ? releaseClaim(pool, claim) : requeueClaim(pool, claim, { delayMs: requeueAfterMs, countAttempt: false });
  try {
    await settle();
    return;
  } catch (error) {
    onError(error, `letting go of the claim for paddle ${claim.paddleId} after its run was recorded; trying once more`);
  }
  try {
    await settle();
  } catch (error) {
    onError(error, `letting go of the claim for paddle ${claim.paddleId} after its run was recorded`);
    await logError(pool, {
      code: "autopilot_release_failed",
      message: "A recorded autopilot run could not let go of its claim; the lease will expire and its reasons be read again.",
      eventId: claim.eventId,
      paddleId: claim.paddleId,
      detail: { reasons: claim.reasons, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
    });
  }
}

export async function runAutopilot(claim: AutopilotClaim, options: RunAutopilotOptions = {}): Promise<RunReport> {
  const database = options.database ?? getDatabaseClient();
  const { pool } = database;
  const onError = options.onError ?? logToConsole;
  const runId = randomUUID();
  const startedAt = new Date();
  const read = await loadAutopilotRead(claim.paddleId, claim.reasons, database);
  const report = reporter(runId);
  if (!read) {
    await releaseClaim(pool, claim);
    return report("skipped", "none", { reason: "no_paddle" });
  }

  const baseRun: BaseRun = {
    id: runId,
    paddleId: claim.paddleId,
    eventId: read.eventId,
    planId: read.plan?.id ?? null,
    triggers: claim.reasons,
    model: null,
    brief: null,
    error: null,
    decision: null,
    issues: null,
    planVersionBefore: read.plan?.version ?? null,
    latencyMs: null,
    usage: null,
    tokensUsed: 0,
    startedAt,
  };

  const gate = autopilotGate(read);
  if (!gate.run) {
    await insertRun(pool, { ...baseRun, outcome: gate.outcome, decidedBy: "none", actionId: null, planVersionAfter: null, error: gate.reason });
    const requeueAfterMs = gate.retryAt ? Math.max(0, gate.retryAt.getTime() - read.now.getTime()) : null;
    await settleClaim(pool, claim, onError, requeueAfterMs);
    return report(gate.outcome, "none", { reason: gate.reason });
  }

  const progress: RunProgress = { deciding: false, run: null };
  let result: RunReport;
  try {
    result = await decideAndApply({ claim, read, context: gate.context, database, options, runId, baseRun, progress });
  } catch (error) {
    // Nothing recorded the outcome, so the run ends failed and the task puts the reasons back for
    // another attempt. Its row keeps what the decision cost (model, usage, tokens): the autopilot's
    // caps count only these rows, so a paid model call whose apply failed still counts.
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const run = progress.run ?? { ...baseRun, decidedBy: "none" as const };
    await finishRun(
      pool,
      { ...run, outcome: "failed", actionId: null, planVersionAfter: null, error: [run.error, message].filter(Boolean).join("; ") },
      progress.deciding ? { kind: "autopilot_finished", runId, outcome: "failed", chatMessageId: null } : null,
    ).catch((recordError: unknown) => onError(recordError, `failed run record for paddle ${claim.paddleId}`));
    throw error;
  }
  // The apply transaction, or finishRun, recorded the outcome: from here nothing is a failed run.
  await settleClaim(pool, claim, onError);
  return result;
}

type BaseRun = Omit<RunRecord, "outcome" | "actionId" | "planVersionAfter" | "decidedBy">;
type RunFields = Omit<RunRecord, "outcome" | "actionId" | "planVersionAfter">;

interface RunProgress {
  /** Set once the "Deciding…" row is written, so the run must end with a finished row. */
  deciding: boolean;
  /** The run's row as the decision left it (model, brief, usage, tokens), once it is made. */
  run: RunFields | null;
}

function reporter(runId: string) {
  return (outcome: AutopilotOutcome, decidedBy: AutopilotDecider, fields: Partial<RunReport> = {}): RunReport => ({
    runId,
    outcome,
    decidedBy,
    reason: null,
    actionId: null,
    chatMessageId: null,
    decision: null,
    ...fields,
  });
}

interface DecideAndApplyInput {
  claim: AutopilotClaim;
  read: AutopilotRead;
  context: AutopilotContext;
  database: DatabaseClient;
  options: RunAutopilotOptions;
  runId: string;
  baseRun: BaseRun;
  progress: RunProgress;
}

/**
 * The decision and its apply, after the gate let the run through. It returns once the outcome is
 * recorded (by the apply transaction, or by finishRun); the caller then releases the claim.
 */
async function decideAndApply({ claim, read, context, database, options, runId, baseRun, progress }: DecideAndApplyInput): Promise<RunReport> {
  const { pool } = database;
  const eventId = read.eventId;
  const report = reporter(runId);
  const decision = await decideAutopilot({
    context,
    model: options.model ?? getGlimModel(),
    modelAllowed: checkAutopilotModel(read.usage, options.dailyTokenBudget ?? getGlimConfig().dailyTokenBudget, read.now),
    signal: options.signal,
    onModelCall: async () => {
      progress.deciding = true;
      await markDeciding(database, eventId, claim.paddleId, runId);
    },
  });
  const decided = decision.modelDecision ?? decision.decision;
  const runFields: RunFields = {
    ...baseRun,
    decidedBy: decision.decidedBy,
    model: decision.model,
    brief: decision.brief,
    error: decision.error ?? (decision.ruleBecause ? `rule: ${decision.ruleBecause}` : null),
    decision: decided ? decisionToJson(decided) : null,
    issues: decision.issues.length > 0 ? decision.issues : null,
    latencyMs: decision.latencyMs,
    usage: decision.usage,
    tokensUsed: decision.tokensUsed,
  };
  // Whatever fails from here, the run's row must still show the model call and what it cost.
  progress.run = runFields;
  if (decision.rejections.length > 0) await insertRejections(pool, decision.rejections, runId);

  let outcome: AutopilotOutcome;
  let reason: string | null = null;
  let actionId: string | null = null;
  let chatMessageId: string | null = null;
  let error = runFields.error;

  if (decision.outcome === "change" && decision.change && decision.decision) {
    let result: ApplyAutopilotResult = await applyAutopilotChange({
      runId,
      paddleId: claim.paddleId,
      eventId,
      planId: context.plan.id,
      planVersion: context.plan.version,
      change: decision.change.change,
      describe: describeChange(runId, context, decision, decision.change.change),
      run: runFields,
      pool,
    });
    if (result.outcome === "refused" && result.refusal && RETRIED_REFUSALS.has(result.refusal.reason)) {
      // A rival bid or a close landed in between: the same decision, priced again on a fresh read.
      const fresh = await loadAutopilotRead(claim.paddleId, claim.reasons, database);
      const freshGate = fresh ? autopilotGate(fresh) : null;
      if (freshGate?.run) {
        const check = checkDecision(decision.decision, freshGate.context);
        if (check.ok && check.action === "change") {
          result = await applyAutopilotChange({
            runId,
            paddleId: claim.paddleId,
            eventId,
            planId: freshGate.context.plan.id,
            planVersion: freshGate.context.plan.version,
            change: check.change,
            describe: describeChange(runId, freshGate.context, decision, check.change),
            run: runFields,
            pool,
          });
        } else {
          result = { outcome: "refused", reason: check.ok ? "no_change" : "rechecked_rejected", refusal: null, issues: check.ok ? [] : check.issues };
        }
      }
    }
    if (result.outcome === "applied") {
      outcome = "applied";
      actionId = result.actionId;
      chatMessageId = result.chatMessageId;
    } else {
      outcome = result.outcome;
      reason = result.reason;
      error = [error, `${result.outcome}: ${result.reason}`].filter(Boolean).join("; ");
    }
  } else if (decision.outcome === "prepare_raise" && decision.raise) {
    const raise = decision.raise;
    const modelWhy = usesModelWhy(decision);
    const why =
      modelWhy ??
      templateWhy({
        context,
        decidedBy: decision.decidedBy,
        reason: decision.reason,
        mainLotId: raise.lotId,
        priorityCall: false,
        topUp: false,
        trigger: primaryTrigger(context.triggers),
      });
    const whySource = modelWhy ? "model" : "template";
    const lines = raiseLines({ context, lotId: raise.lotId, lotNumber: raise.lotNumber, amountCents: raise.amountCents });
    const expiresAt = new Date(context.state.now.getTime() + RAISE_PENDING_SECONDS * 1000);
    const prepared = await prepareAutopilotRaise({
      runId,
      paddleId: claim.paddleId,
      eventId,
      planId: context.plan.id,
      planVersion: context.plan.version,
      amountCents: raise.amountCents,
      change: raise.atCeiling.change,
      intent: raise.lots,
      describe: (ids) => ({
        action: {
          lotId: raise.lotId,
          amountCents: raise.amountCents,
          limitCents: null,
          chip: "none",
          message: lines.askLine,
          detail: {
            runId,
            triggers: context.triggers,
            pendingIntent: raise.lots,
            lotIds: raise.atCeiling.change.after.map((lot) => lot.lotId),
            raise: raise.bounds,
            decidedBy: decision.decidedBy,
            why,
            whySource,
            reason: decision.reason,
            adjusted: decision.adjusted,
            amountsCents: lines.amountsCents,
          },
        },
        card: {
          ...autopilotRaiseCard({
            runId,
            actionId: ids.actionId,
            context,
            lines,
            lotId: raise.lotId,
            amountCents: raise.amountCents,
            why,
            whySource,
            expiresAt,
          }),
        },
      }),
      run: runFields,
      pool,
    });
    if (prepared.outcome === "raise_prepared") {
      outcome = "raise_prepared";
      actionId = prepared.actionId;
      chatMessageId = prepared.chatMessageId;
    } else {
      outcome = prepared.outcome;
      reason = prepared.reason;
      error = [error, `${prepared.outcome}: ${prepared.reason}`].filter(Boolean).join("; ");
    }
  } else {
    outcome = decision.outcome === "keep" ? "kept" : "skipped";
    reason = decision.outcome === "keep" ? decision.reason : "no_options";
  }

  if (outcome !== "applied" && outcome !== "raise_prepared") {
    await finishRun(
      pool,
      { ...runFields, error, outcome, actionId: null, planVersionAfter: null },
      progress.deciding ? { kind: "autopilot_finished", runId, outcome, chatMessageId: null } : null,
    );
  }
  return report(outcome, decision.decidedBy, { reason, actionId, chatMessageId, decision });
}
