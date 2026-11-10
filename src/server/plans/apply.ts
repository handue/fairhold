/**
 * The one writer of Glim plans (docs/planning/glim-autopilot.md §5.2). Autopilot changes a plan
 * through applyAutopilotChange and prepareAutopilotRaise; the guest through confirmPlan and
 * skipLot. Each runs in one transaction that takes its locks in the engine's order with one Glim
 * lock in front: the paddle's running plan row, then every lot it touches in id order, then
 * (inside the engine) paddle rows and holds, then the event_log ordering lock (§5.3). The engine
 * change and its records commit together or not at all. Nothing here calls PayPal.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import { getPool } from "@/server/db/client";
import {
  COMMITMENTS_SQL,
  createLimits,
  removeLimit,
  type LimitView,
  type LotView,
  type PlacedBid,
  type Refusal,
} from "@/server/engine";
import { sortedUnique } from "@/server/engine/ids";
import type { PlanCard } from "@/server/glim/cards";
import type { AppliedFacts } from "@/server/glim/autopilot/copy";
import type { AutopilotChange, AutopilotDecisionLot } from "@/server/glim/autopilot/types";
import { inconsistentChange, mandateViolations, MAX_RAISES_PER_PADDLE } from "@/server/glim/autopilot/validate";
import { CLOSE_MARGIN_MS, mandateFromConfirmedCard, parseMandate, type GlimMandate } from "@/server/glim/mandate";
import { planLine } from "@/server/glim/copy";
import { formatUsd } from "@/server/glim/money";
import type { ValidationIssue } from "@/server/glim/types";
import { appendEventLog } from "@/server/sse/notify";

import { logError, PlanAbort, withPlanTransaction, type Queryable } from "./db";
import { planCardSchema } from "./proposals";
import { insertRun, type RunRecord } from "./runs";

/** An unconfirmed plan card younger than this suspends autopilot (§2.5). */
export const PENDING_CARD_SECONDS = 120;
/** A prepared raise stays open this long (§6.4). */
export const RAISE_PENDING_SECONDS = 600;

type PlanRow = {
  id: string;
  status: "proposed" | "active" | "paused" | "ended" | "superseded";
  version: number;
  mandate: unknown;
  proposal: unknown;
  budget_cents: number;
  source_message_id: string | null;
};

async function lockRunningPlan(client: Queryable, paddleId: string): Promise<PlanRow | null> {
  const { rows } = await client.query<PlanRow>(
    `select id, status, version, mandate, proposal, budget_cents, source_message_id
     from glim_plans where paddle_id = $1 and status in ('active', 'paused')
     for update`,
    [paddleId],
  );
  return rows[0] ?? null;
}

interface LockedLot {
  id: string;
  number: number;
  shortTitle: string;
  closesAt: Date;
  open: boolean;
}

/**
 * Locks the lots in id order with the engine's own statement shape (pg-store.ts lockLots), then
 * reads the database clock once every lock is held.
 */
async function lockLots(client: Queryable, lotIds: readonly string[]): Promise<{ lots: Map<string, LockedLot>; now: Date }> {
  const ids = sortedUnique(lotIds);
  if (ids.length > 0) {
    await client.query("select id from lots where id = any($1) order by id for update", [ids]);
  }
  const { rows } = await client.query<{ now: Date }>("select clock_timestamp() as now");
  const now = rows[0]?.now ?? new Date();
  if (ids.length === 0) return { lots: new Map(), now };
  const read = await client.query<{ id: string; number: number; short_title: string; status: string; closes_at: Date }>(
    "select id, number, short_title, status, closes_at from lots where id = any($1)",
    [ids],
  );
  return {
    now,
    lots: new Map(
      read.rows.map((row) => [
        row.id,
        {
          id: row.id,
          number: row.number,
          shortTitle: row.short_title,
          closesAt: row.closes_at,
          open: row.status === "open" && row.closes_at.getTime() > now.getTime(),
        },
      ]),
    ),
  };
}

interface LimitRead {
  lotId: string;
  owner: "glim" | "guest_max";
  maxCents: number;
  active: boolean;
  createdAt: Date;
}

/** This paddle's limits on these lots that matter to the fences; read under the lot locks, so they hold. */
async function limitsOn(client: Queryable, paddleId: string, lotIds: readonly string[], confirmedAt: string): Promise<LimitRead[]> {
  if (lotIds.length === 0) return [];
  const { rows } = await client.query<{ lot_id: string; owner: LimitRead["owner"]; max_cents: number; active: boolean; created_at: Date }>(
    `select lot_id, owner, max_cents, active, created_at from bid_limits
     where paddle_id = $1 and lot_id = any($2) and (active or (owner = 'guest_max' and created_at >= $3))`,
    [paddleId, lotIds, confirmedAt],
  );
  return rows.map((row) => ({ lotId: row.lot_id, owner: row.owner, maxCents: row.max_cents, active: row.active, createdAt: row.created_at }));
}

function guestControlled(limits: readonly LimitRead[], confirmedAt: string): Set<string> {
  const cutoff = Date.parse(confirmedAt);
  return new Set(
    limits
      .filter((limit) => limit.owner === "guest_max" && (limit.active || limit.createdAt.getTime() >= cutoff))
      .map((limit) => limit.lotId),
  );
}

async function pendingCard(client: Queryable, paddleId: string): Promise<boolean> {
  const { rows } = await client.query<{ pending: boolean }>(
    `select exists (
       select 1 from glim_plans
       where paddle_id = $1 and status = 'proposed' and created_at > now() - make_interval(secs => $2)
     ) as pending`,
    [paddleId, PENDING_CARD_SECONDS],
  );
  return rows[0]?.pending === true;
}

async function authorizedHold(client: Queryable, paddleId: string): Promise<number | null> {
  const { rows } = await client.query<{ amount_cents: number }>(
    "select amount_cents from holds where paddle_id = $1 and status = 'authorized'",
    [paddleId],
  );
  return rows[0]?.amount_cents ?? null;
}

/** spendM: the engine's commitments (COMMITMENTS_SQL) on the mandate's lots, as this transaction sees them. */
export async function spendOnMandate(client: Queryable, paddleId: string, mandate: GlimMandate): Promise<number> {
  const { rows } = await client.query<{ lot_id: string; commitment_cents: number }>(COMMITMENTS_SQL, [[paddleId]]);
  const inMandate = new Set(mandate.lots.map((lot) => lot.lotId));
  return rows.filter((row) => inMandate.has(row.lot_id)).reduce((sum, row) => sum + row.commitment_cents, 0);
}

type LotFacts = AppliedFacts["lots"][number];

/**
 * Who leads each of these lots and at what, after the engine's writes: this transaction holds
 * their row locks, so the read is what the change actually left, for lots the engine result does
 * not list (a removed limit's lot, a plan item's lot).
 */
async function lotFactsAfter(client: Queryable, lotIds: readonly string[]): Promise<LotFacts[]> {
  if (lotIds.length === 0) return [];
  const { rows } = await client.query<{ id: string; current_bid_cents: number | null; high_paddle_id: string | null }>(
    "select id, current_bid_cents, high_paddle_id from lots where id = any($1)",
    [lotIds],
  );
  return rows.map((row) => ({ lotId: row.id, currentBidCents: row.current_bid_cents, highPaddleId: row.high_paddle_id }));
}

function appliedFacts(
  paddleId: string,
  result: { bids: PlacedBid[]; limits: LimitView[]; lots: LotView[] } | null,
  touchedLots: readonly LotFacts[],
): AppliedFacts {
  const lots: LotFacts[] = (result?.lots ?? []).map((lot) => ({ lotId: lot.id, currentBidCents: lot.currentBidCents, highPaddleId: lot.highPaddleId }));
  for (const lot of touchedLots) if (!lots.some((entry) => entry.lotId === lot.lotId)) lots.push(lot);
  return {
    paddleId,
    bids: (result?.bids ?? []).map((bid) => ({ id: bid.id, lotId: bid.lotId, paddleId: bid.paddleId, amountCents: bid.amountCents, source: bid.source })),
    limits: (result?.limits ?? []).map((limit) => ({ id: limit.id, lotId: limit.lotId, maxCents: limit.maxCents, active: limit.active })),
    lots,
  };
}

/** The action row and the card a change or a raise writes, built by the caller from what happened. */
export interface AutopilotRecordDraft {
  action: {
    lotId: string | null;
    amountCents: number | null;
    limitCents: number | null;
    chip: "winning" | "none";
    message: string;
    detail: Record<string, unknown>;
  };
  card: Record<string, unknown>;
}

type RunFields = Omit<RunRecord, "outcome" | "actionId" | "planVersionAfter">;

export interface ApplyAutopilotInput {
  runId: string;
  paddleId: string;
  eventId: string;
  planId: string;
  planVersion: number;
  change: AutopilotChange;
  /** Pure: the action and card from the engine's actual result. */
  describe: (applied: AppliedFacts, ids: { actionId: string; chatMessageId: string }) => AutopilotRecordDraft;
  run: RunFields;
  pool?: pg.Pool;
}

export type ApplyAutopilotResult =
  | { outcome: "applied"; actionId: string; chatMessageId: string; planVersion: number; applied: AppliedFacts }
  | { outcome: "stale"; reason: string }
  | { outcome: "refused"; reason: string; refusal: Refusal | null; issues: ValidationIssue[] };

type Aborted = Exclude<ApplyAutopilotResult, { outcome: "applied" }> & { log?: { code: string; message: string; detail: unknown } };

/** The outcome without its error_log entry, which is written after the rollback. */
function withoutLog(aborted: Aborted): Exclude<ApplyAutopilotResult, { outcome: "applied" }> {
  const { log, ...outcome } = aborted;
  void log;
  return outcome;
}

const stale = (reason: string): never => {
  throw new PlanAbort<Aborted>({ outcome: "stale", reason });
};
const refused = (reason: string, fields: { refusal?: Refusal | null; issues?: ValidationIssue[]; log?: Aborted["log"] } = {}): never => {
  throw new PlanAbort<Aborted>({ outcome: "refused", reason, refusal: fields.refusal ?? null, issues: fields.issues ?? [], log: fields.log });
};

/** Every lot a change names: the plan after it, the limits it writes and the ones it ends. */
function changeLotIds(change: AutopilotChange): string[] {
  return sortedUnique([...change.after.map((lot) => lot.lotId), ...change.set.map((lot) => lot.lotId), ...change.removeLotIds]);
}

/**
 * Step 4's checks under the lot locks (§5.2, §5.4), in an order that keeps races apart from bugs:
 *  1. A change whose halves disagree (inconsistentChange) is a bug, whatever else happened.
 *  2. Races end the run without a log: the guest's own max on any lot the change keeps or writes
 *     (stale, guest_max), and a lot it writes that closed or came within 5 s of closing while the
 *     decision was made (refused, lot_closed, the engine's own refusal, retried once on a fresh read).
 *  3. Anything else that breaks the mandate (R1–R5) is a validator bug: refused and logged. Nothing
 *     a guest or a rival does can cause it: the mandate itself changes only under the plan row lock,
 *     and with it the plan version.
 * Limit rows change only while their lot is locked, so for every lot the change writes these
 * reads hold until commit; a lot it only keeps is read as of now.
 */
function fenceChange(
  change: AutopilotChange,
  mandate: GlimMandate,
  locked: { lots: ReadonlyMap<string, LockedLot>; now: Date },
  limits: readonly LimitRead[],
  what: "change" | "raise",
): void {
  const subject = what === "change" ? "An autopilot change" : "A prepared raise";
  const inconsistent = inconsistentChange(change);
  if (inconsistent.length > 0) {
    return refused("inconsistent_change", {
      issues: inconsistent,
      log: { code: "autopilot_validator_bug", message: `${subject} named limits its own plan does not hold.`, detail: inconsistent },
    });
  }
  const controlled = guestControlled(limits, mandate.confirmedAt);
  if (changeLotIds(change).some((lotId) => controlled.has(lotId))) return stale("guest_max");
  const closed = change.set.find((lot) => {
    const read = locked.lots.get(lot.lotId);
    return !read || !read.open || read.closesAt.getTime() - locked.now.getTime() <= CLOSE_MARGIN_MS;
  });
  if (closed) {
    const read = locked.lots.get(closed.lotId);
    return refused("lot_closed", {
      refusal: { reason: "lot_closed", lotId: closed.lotId, closesAt: read?.closesAt ?? locked.now, closedAt: null },
    });
  }
  const violations = mandateViolations(change, mandate, { now: locked.now, lots: locked.lots, guestControlledLotIds: controlled });
  if (violations.length > 0) {
    refused("mandate_violation", {
      issues: violations,
      log: { code: "autopilot_validator_bug", message: `${subject} broke the mandate under the apply transaction's locks.`, detail: violations },
    });
  }
}

/**
 * Applies an autopilot change (§5.2 steps 1-9): the plan fence, the lot locks, the fences under
 * them (fenceChange: the change's halves agree, the guest's own maximum and a closing lot as
 * races, the mandate rules again on every lot it keeps or writes; then a pending card), the plan
 * items, the engine (createLimits, all or nothing, which refuses anything over the hold), the
 * after-check of the named budget under the engine's paddle and hold locks, and the records.
 */
export async function applyAutopilotChange(input: ApplyAutopilotInput): Promise<ApplyAutopilotResult> {
  const pool = input.pool ?? getPool();
  const { change, paddleId } = input;
  const result = await withPlanTransaction<ApplyAutopilotResult | Aborted>(pool, async ({ client, store }) => {
    // 2. The plan row fence.
    const plan = await lockRunningPlan(client, paddleId);
    if (!plan || plan.id !== input.planId) return stale("plan_replaced");
    if (plan.status !== "active") return stale("plan_paused");
    if (plan.version !== input.planVersion) return stale("plan_version");
    const mandate = parseMandate(plan.mandate);
    if (!mandate) return stale("no_mandate");

    // 3. Every lot the change touches or references, in id order.
    const items = await client.query<{ id: string; lot_id: string; priority: number; max_cents: number }>(
      "select id, lot_id, priority, max_cents from glim_plan_items where plan_id = $1",
      [plan.id],
    );
    const itemByLot = new Map(items.rows.map((row) => [row.lot_id, row]));
    const afterIds = new Set(change.after.map((lot) => lot.lotId));
    const inserted = change.after.filter((lot) => !itemByLot.has(lot.lotId));
    const deleted = items.rows.filter((row) => !afterIds.has(row.lot_id));
    const touched = sortedUnique([
      ...change.set.map((lot) => lot.lotId),
      ...change.removeLotIds,
      ...inserted.map((lot) => lot.lotId),
      ...deleted.map((row) => row.lot_id),
    ]);
    const locked = await lockLots(client, touched);

    // 4. Fences, under the lot locks: limit rows change only while their lot is locked.
    const limits = await limitsOn(client, paddleId, sortedUnique([...touched, ...changeLotIds(change)]), mandate.confirmedAt);
    fenceChange(change, mandate, locked, limits, "change");
    if (await pendingCard(client, paddleId)) return stale("pending_card");
    const liveNow = new Map(limits.filter((limit) => limit.owner === "glim" && limit.active).map((limit) => [limit.lotId, limit.maxCents]));
    const lowerOrDropOnly = change.set.every((lot) => {
      const current = liveNow.get(lot.lotId);
      return current !== undefined && lot.maxCents <= current;
    });

    // 5. Plan items, before the engine: their foreign-key locks fall on lots already held.
    const itemIds = new Map<string, string>();
    for (const lot of change.after) {
      const existing = itemByLot.get(lot.lotId);
      if (existing) {
        itemIds.set(lot.lotId, existing.id);
        if (existing.priority !== lot.priority || existing.max_cents !== lot.maxCents) {
          await client.query("update glim_plan_items set priority = $2, max_cents = $3 where id = $1", [existing.id, lot.priority, lot.maxCents]);
        }
        continue;
      }
      const insertedItem = await client.query<{ id: string }>(
        `insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status)
         values ($1, $2, $3, $4, 'watching') returning id`,
        [plan.id, lot.lotId, lot.priority, lot.maxCents],
      );
      const id = insertedItem.rows[0]?.id;
      if (id) itemIds.set(lot.lotId, id);
    }
    if (deleted.length > 0) {
      await client.query("delete from glim_plan_items where id = any($1)", [deleted.map((row) => row.id)]);
    }

    // 6. The engine, inside this transaction: all or nothing, within the hold.
    let engineResult: { bids: PlacedBid[]; limits: LimitView[]; lots: LotView[] } | null = null;
    if (change.set.length > 0) {
      const created = await createLimits(
        paddleId,
        change.set.map((lot) => ({ lotId: lot.lotId, maxCents: lot.maxCents, planItemId: itemIds.get(lot.lotId) ?? null })),
        { owner: "glim", removeLotIds: change.removeLotIds, store },
      );
      if (!created.ok) return refused(created.refusal.reason, { refusal: created.refusal });
      engineResult = created;
    } else {
      for (const lotId of change.removeLotIds) await removeLimit(paddleId, lotId, { owner: "glim", store });
    }

    // 7. The after-check, under the engine's paddle and hold locks: the named budget holds.
    const spend = await spendOnMandate(client, paddleId, mandate);
    if (mandate.budgetCents !== null && spend > mandate.budgetCents && !lowerOrDropOnly) {
      return refused("over_budget", {
        log: {
          code: "autopilot_after_check",
          message: `An autopilot change would commit ${formatUsd(spend)} on the mandate's lots, over the ${formatUsd(mandate.budgetCents)} budget.`,
          detail: { spendCents: spend, budgetCents: mandate.budgetCents, change },
        },
      });
    }
    const hold = await authorizedHold(client, paddleId);

    // 8. The records, in the same transaction.
    const version = await client.query<{ version: number }>(
      "update glim_plans set version = version + 1 where id = $1 returning version",
      [plan.id],
    );
    const planVersion = version.rows[0]?.version ?? plan.version + 1;
    // What the engine left on every lot this change touched, read under the lot locks: the card's
    // "Your $X bid stands" for a dropped lot comes from here, never from the run's earlier read.
    const applied = appliedFacts(paddleId, engineResult, await lotFactsAfter(client, touched));
    const actionId = randomUUID();
    const chatMessageId = randomUUID();
    const draft = input.describe(applied, { actionId, chatMessageId });
    await client.query(
      `insert into glim_actions
         (id, paddle_id, plan_id, lot_id, kind, amount_cents, limit_cents, hold_cents_at_time, decision, message, chip, detail)
       values ($1, $2, $3, $4, 'autopilot_changed', $5, $6, $7, 'executed', $8, $9, $10::jsonb)`,
      [
        actionId,
        paddleId,
        plan.id,
        draft.action.lotId,
        draft.action.amountCents,
        draft.action.limitCents,
        hold,
        draft.action.message,
        draft.action.chip,
        JSON.stringify(draft.action.detail),
      ],
    );
    const glimBidIds = applied.bids.filter((bid) => bid.paddleId === paddleId && bid.source === "glim").map((bid) => bid.id);
    if (glimBidIds.length > 0) {
      await client.query("update bids set glim_action_id = $1 where id = any($2)", [actionId, glimBidIds]);
    }
    await client.query(
      `insert into chat_messages (id, paddle_id, role, text, card_type, card, plan_id, tokens_used)
       values ($1, $2, 'glim', '', 'action', $3::jsonb, $4, 0)`,
      [chatMessageId, paddleId, JSON.stringify(draft.card), plan.id],
    );
    await insertRun(client, { ...input.run, outcome: "applied", actionId, planVersionAfter: planVersion });
    await appendEventLog(client, [
      {
        eventId: input.eventId,
        paddleId,
        type: "glim",
        payload: {
          kind: "autopilot_finished",
          runId: input.runId,
          outcome: "applied",
          chatMessageId,
          actionId,
          lotIds: sortedUnique([...change.set.map((lot) => lot.lotId), ...change.removeLotIds]),
          // The live layer skips the limit_set and opening limit_raised rows of these limits (§6.2).
          limitIds: applied.limits.map((limit) => limit.id),
        },
      },
    ]);
    return { outcome: "applied", actionId, chatMessageId, planVersion, applied };
  });
  if ("log" in result && result.log) {
    await logError(pool, { ...result.log, eventId: input.eventId, paddleId });
  }
  if (result.outcome === "applied") return result;
  return withoutLog(result as Aborted);
}

export interface PrepareRaiseInput {
  runId: string;
  paddleId: string;
  eventId: string;
  planId: string;
  planVersion: number;
  amountCents: number;
  /** The plan the raise is for, as checked at the raised hold; only its mandate rules are rechecked. */
  change: AutopilotChange;
  intent: AutopilotDecisionLot[];
  describe: (ids: { actionId: string; chatMessageId: string }) => AutopilotRecordDraft;
  run: RunFields;
  pool?: pg.Pool;
}

export type PrepareRaiseResult =
  | { outcome: "raise_prepared"; actionId: string; chatMessageId: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "refused"; reason: string; refusal: Refusal | null; issues: ValidationIssue[] };

/**
 * Stores a raise for the guest to approve (§6.4): the same plan, lot and pending-card fences as
 * a change, the raise caps again under the plan row lock, and no engine change. Only the guest's
 * tap creates a PayPal order (Day 2 createHold), for the amount stored here.
 */
export async function prepareAutopilotRaise(input: PrepareRaiseInput): Promise<PrepareRaiseResult> {
  const pool = input.pool ?? getPool();
  const { paddleId, change } = input;
  const result = await withPlanTransaction<PrepareRaiseResult | Aborted>(pool, async ({ client }) => {
    const plan = await lockRunningPlan(client, paddleId);
    if (!plan || plan.id !== input.planId) return stale("plan_replaced");
    if (plan.status !== "active") return stale("plan_paused");
    if (plan.version !== input.planVersion) return stale("plan_version");
    const mandate = parseMandate(plan.mandate);
    if (!mandate) return stale("no_mandate");
    const lotIds = changeLotIds(change);
    const locked = await lockLots(client, lotIds);
    const limits = await limitsOn(client, paddleId, lotIds, mandate.confirmedAt);
    // The same fences as a change: a lot closing or a guest max while the model decided is a race.
    fenceChange(change, mandate, locked, limits, "raise");
    if (await pendingCard(client, paddleId)) return stale("pending_card");

    const hold = await authorizedHold(client, paddleId);
    if (hold === null || input.amountCents <= hold) return refused("not_a_raise");
    if (mandate.budgetCents === null || input.amountCents > mandate.budgetCents) return refused("raise_over_budget");
    const raises = await client.query<{ count: number; pending: boolean }>(
      `select count(*)::int as count,
         coalesce(bool_or(a.created_at > now() - make_interval(secs => $2) and a.amount_cents > $3
           and a.plan_id = $4
           and not (coalesce(a.detail, '{}'::jsonb) ? 'dismissedAt')
           and not exists (select 1 from glim_actions c where c.paddle_id = a.paddle_id
                           and c.kind = 'autopilot_changed' and c.created_at > a.created_at)), false) as pending
       from glim_actions a where a.paddle_id = $1 and a.kind = 'autopilot_raise_prepared'`,
      // An offer for a plan the guest has since replaced ended with that plan (raise-offer.ts).
      [paddleId, RAISE_PENDING_SECONDS, hold, plan.id],
    );
    if ((raises.rows[0]?.count ?? 0) >= MAX_RAISES_PER_PADDLE) return refused("raise_limit_reached");
    if (raises.rows[0]?.pending) return refused("raise_pending");

    const actionId = randomUUID();
    const chatMessageId = randomUUID();
    const draft = input.describe({ actionId, chatMessageId });
    await client.query(
      `insert into glim_actions
         (id, paddle_id, plan_id, lot_id, kind, amount_cents, limit_cents, hold_cents_at_time, decision, message, chip, detail)
       values ($1, $2, $3, $4, 'autopilot_raise_prepared', $5, $6, $7, 'executed', $8, 'none', $9::jsonb)`,
      [
        actionId,
        paddleId,
        plan.id,
        draft.action.lotId,
        input.amountCents,
        draft.action.limitCents,
        hold,
        draft.action.message,
        JSON.stringify(draft.action.detail),
      ],
    );
    await client.query(
      `insert into chat_messages (id, paddle_id, role, text, card_type, card, plan_id, tokens_used)
       values ($1, $2, 'glim', '', 'action', $3::jsonb, $4, 0)`,
      [chatMessageId, paddleId, JSON.stringify(draft.card), plan.id],
    );
    await insertRun(client, { ...input.run, outcome: "raise_prepared", actionId, planVersionAfter: plan.version });
    await appendEventLog(client, [
      {
        eventId: input.eventId,
        paddleId,
        type: "glim",
        payload: { kind: "autopilot_finished", runId: input.runId, outcome: "raise_prepared", chatMessageId, actionId },
      },
    ]);
    return { outcome: "raise_prepared", actionId, chatMessageId };
  });
  if ("log" in result && result.log) {
    await logError(pool, { ...result.log, eventId: input.eventId, paddleId });
  }
  if (result.outcome === "raise_prepared") return result;
  return withoutLog(result as Aborted);
}

export type ConfirmPlanResult =
  | {
      ok: true;
      planId: string;
      mandate: GlimMandate | null;
      limits: LimitView[];
      bids: PlacedBid[];
      actionId: string;
      /** True when the card replaced a running or paused plan: an edit (design/22 #18), not a start. */
      replaced: boolean;
      /** The plan's lots and maximums in one line, as the "Plan started" card reads. */
      message: string;
    }
  | { ok: false; reason: "not_found" | "not_proposed" | "invalid_card" | "empty_card" }
  | { ok: false; reason: "refused"; refusal: Refusal };

/**
 * The guest's Start bidding on a plan card (§5.2): the running plan is superseded and the card's
 * plan becomes active with the card's exact maxima, all or nothing through createLimits. When
 * autopilot was on for the card, its mandate is stored and autopilot is armed from the paddle's
 * latest event_log row, read after the engine's writes.
 */
export async function confirmPlan(input: { paddleId: string; proposedPlanId: string; pool?: pg.Pool }): Promise<ConfirmPlanResult> {
  const pool = input.pool ?? getPool();
  const { paddleId } = input;
  type Failed = Extract<ConfirmPlanResult, { ok: false }>;
  const fail = (value: Failed): never => {
    throw new PlanAbort<Failed>(value);
  };
  return withPlanTransaction<ConfirmPlanResult>(pool, async ({ client, store }) => {
    const plans = await client.query<PlanRow>(
      `select id, status, version, mandate, proposal, budget_cents, source_message_id
       from glim_plans where paddle_id = $1 and (id = $2 or status in ('active', 'paused'))
       order by id for update`,
      [paddleId, input.proposedPlanId],
    );
    const proposed = plans.rows.find((row) => row.id === input.proposedPlanId);
    if (!proposed) return fail({ ok: false, reason: "not_found" });
    if (proposed.status !== "proposed") return fail({ ok: false, reason: "not_proposed" });
    const running = plans.rows.find((row) => row.id !== proposed.id && (row.status === "active" || row.status === "paused")) ?? null;
    const card = await readPlanCard(client, proposed);
    if (!card) return fail({ ok: false, reason: "invalid_card" });
    if (card.items.length === 0) return fail({ ok: false, reason: "empty_card" });

    const paddle = await client.query<{ event_id: string }>("select event_id from paddles where id = $1", [paddleId]);
    const eventId = paddle.rows[0]?.event_id;
    if (!eventId) return fail({ ok: false, reason: "not_found" });
    const liveGlim = await client.query<{ lot_id: string }>(
      "select lot_id from bid_limits where paddle_id = $1 and owner = 'glim' and active",
      [paddleId],
    );
    const cardLotIds = card.items.map((item) => item.lotId);
    const removeLotIds = sortedUnique(liveGlim.rows.map((row) => row.lot_id).filter((lotId) => !cardLotIds.includes(lotId)));
    const proposedItems = await client.query<{ lot_id: string }>("select lot_id from glim_plan_items where plan_id = $1", [proposed.id]);
    await lockLots(client, [...cardLotIds, ...removeLotIds, ...proposedItems.rows.map((row) => row.lot_id)]);

    // Superseded first: one running plan per paddle (glim_plans_one_running_per_paddle_uq).
    if (running) {
      await client.query("update glim_plans set status = 'superseded', ended_at = now() where id = $1", [running.id]);
    }
    const now = await client.query<{ now: Date }>("select now() as now");
    const confirmedAt = now.rows[0]?.now ?? new Date();
    const mandate = card.autopilot
      ? mandateFromConfirmedCard({
          card,
          guestWords: await guestWords(client, paddleId, proposed.source_message_id),
          confirmedAt,
          previous: running ? parseMandate(running.mandate) : null,
        })
      : null;
    await client.query(
      "update glim_plans set status = 'active', confirmed_at = $2, mandate = $3::jsonb where id = $1",
      [proposed.id, confirmedAt, mandate === null ? null : JSON.stringify(mandate)],
    );

    await client.query("delete from glim_plan_items where plan_id = $1", [proposed.id]);
    const itemIds = new Map<string, string>();
    for (const item of card.items) {
      const inserted = await client.query<{ id: string }>(
        `insert into glim_plan_items (plan_id, lot_id, priority, max_cents, status)
         values ($1, $2, $3, $4, 'watching') returning id`,
        [proposed.id, item.lotId, item.priority, item.maxCents],
      );
      const id = inserted.rows[0]?.id;
      if (id) itemIds.set(item.lotId, id);
    }

    const created = await createLimits(
      paddleId,
      card.items.map((item) => ({ lotId: item.lotId, maxCents: item.maxCents, planItemId: itemIds.get(item.lotId) ?? null })),
      { owner: "glim", removeLotIds, store },
    );
    if (!created.ok) return fail({ ok: false, reason: "refused", refusal: created.refusal });

    const hold = await authorizedHold(client, paddleId);
    const actionId = randomUUID();
    const message = planLine(card.items);
    await client.query(
      `insert into glim_actions (id, paddle_id, plan_id, kind, amount_cents, hold_cents_at_time, decision, message, chip)
       values ($1, $2, $3, $4, $5, $6, 'executed', $7, 'none')`,
      [actionId, paddleId, proposed.id, running ? "plan_edited" : "plan_started", card.totalCents, hold, message],
    );
    const glimBidIds = created.bids.filter((bid) => bid.paddleId === paddleId && bid.source === "glim").map((bid) => bid.id);
    if (glimBidIds.length > 0) {
      await client.query("update bids set glim_action_id = $1 where id = any($2)", [actionId, glimBidIds]);
    }
    if (mandate) {
      // Armed from the latest row on the paddle's channel: this transaction holds the event's
      // event_log ordering lock (taken by the engine's writes), so no later row is missed.
      await client.query(
        `insert into glim_autopilot (paddle_id, event_id, cursor_event_log_id)
         values ($1, $2, (select coalesce(max(id), 0) from event_log where paddle_id = $1))
         on conflict (paddle_id) do update set
           event_id = excluded.event_id, cursor_event_log_id = excluded.cursor_event_log_id,
           reasons = '[]'::jsonb, closing_reviewed = '[]'::jsonb, due_at = null, attempts = 0, updated_at = now()`,
        [paddleId, eventId],
      );
    }
    return { ok: true, planId: proposed.id, mandate, limits: created.limits, bids: created.bids, actionId, replaced: running !== null, message };
  });
}

/** The card a proposed plan row was shown with: proposal.card, else its chat message's card. */
async function readPlanCard(client: Queryable, plan: PlanRow): Promise<PlanCard | null> {
  const stored = (plan.proposal as { card?: unknown } | null)?.card;
  const fromProposal = planCardSchema.safeParse(stored);
  if (fromProposal.success) return fromProposal.data;
  const { rows } = await client.query<{ card: unknown }>(
    "select card from chat_messages where plan_id = $1 and card_type = 'plan' order by created_at desc limit 1",
    [plan.id],
  );
  const fromMessage = planCardSchema.safeParse(rows[0]?.card);
  return fromMessage.success ? fromMessage.data : null;
}

/** The guest's message behind a card: the source message, or the latest guest message before it. */
async function guestWords(client: Queryable, paddleId: string, sourceMessageId: string | null): Promise<string[]> {
  if (!sourceMessageId) return [];
  const { rows } = await client.query<{ text: string }>(
    `select m.text from chat_messages m
     join chat_messages source on source.id = $2
     where m.paddle_id = $1 and m.role = 'guest' and m.created_at <= source.created_at
       and (source.role <> 'guest' or m.id = source.id)
     order by m.created_at desc limit 1`,
    [paddleId, sourceMessageId],
  );
  return rows.map((row) => row.text);
}

export type SkipLotResult =
  | { ok: true; removed: boolean; planVersion: number; actionId: string }
  | { ok: false; reason: "no_plan" };

/**
 * The guest's Skip on a lot (§2.5, §6.5): Glim's limit there ends (bids stand), the lot is ruled
 * out in the mandate so autopilot never adds it back, its plan item is skipped and the plan
 * version moves, which turns any decision in flight stale.
 */
export async function skipLot(input: { paddleId: string; lotId: string; pool?: pg.Pool }): Promise<SkipLotResult> {
  const pool = input.pool ?? getPool();
  const { paddleId, lotId } = input;
  return withPlanTransaction<SkipLotResult>(pool, async ({ client, store }) => {
    const plan = await lockRunningPlan(client, paddleId);
    if (!plan) throw new PlanAbort<SkipLotResult>({ ok: false, reason: "no_plan" });
    const locked = await lockLots(client, [lotId]);
    const { removed } = await removeLimit(paddleId, lotId, { owner: "glim", store });
    await client.query("update glim_plan_items set status = 'skipped' where plan_id = $1 and lot_id = $2", [plan.id, lotId]);
    const mandate = parseMandate(plan.mandate);
    const nextMandate =
      mandate && !mandate.excludedLotIds.includes(lotId) ? { ...mandate, excludedLotIds: [...mandate.excludedLotIds, lotId] } : mandate;
    const version = await client.query<{ version: number }>(
      "update glim_plans set version = version + 1, mandate = $2::jsonb where id = $1 returning version",
      [plan.id, nextMandate === null ? null : JSON.stringify(nextMandate)],
    );
    const lot = locked.lots.get(lotId);
    const leading = await client.query<{ current_bid_cents: number | null }>(
      "select current_bid_cents from lots where id = $1 and high_paddle_id = $2",
      [lotId, paddleId],
    );
    const standing = leading.rows[0]?.current_bid_cents ?? null;
    const title = lot?.shortTitle ?? "this lot";
    const actionId = randomUUID();
    await client.query(
      `insert into glim_actions (id, paddle_id, plan_id, lot_id, kind, hold_cents_at_time, decision, message, chip)
       values ($1, $2, $3, $4, 'plan_edited', $5, 'executed', $6, 'none')`,
      [
        actionId,
        paddleId,
        plan.id,
        lotId,
        await authorizedHold(client, paddleId),
        standing === null ? `I stopped bidding on ${title}.` : `I stopped bidding on ${title}. Your ${formatUsd(standing)} bid stands.`,
      ],
    );
    return { ok: true, removed: removed !== null, planVersion: version.rows[0]?.version ?? plan.version + 1, actionId };
  });
}
