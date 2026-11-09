/**
 * What wakes Glim (docs/planning/glim-autopilot.md §3): the tick reads each armed paddle's own
 * event_log rows after its cursor, keeps the facts that change the guest's options, and claims a
 * paddle once its one-second debounce has passed. event_log ids are handed out in commit order
 * per event under an advisory lock (src/server/sse/notify.ts), and a paddle belongs to one event,
 * so advancing the cursor past every row read can never skip a row that commits later.
 */
import { z } from "zod";

import type { AutopilotTrigger } from "@/server/glim/autopilot/types";
import { parseMandate } from "@/server/glim/mandate";

import { logError, type Queryable } from "./db";

/** Facts collected after the first one wait this long, so one run sees them all. */
export const DEBOUNCE_SECONDS = 1;
/** A run's claim is a lease: past this, another tick may take the paddle over. */
export const LEASE_SECONDS = 60;
/** A plan lot closing within this long may wake Glim once (closing_soon). */
export const CLOSING_SOON_SECONDS = 90;
/** A run that keeps failing is given up after this many attempts. */
export const MAX_RUN_ATTEMPTS = 3;
export const SCAN_LIMIT = 500;

const triggerSchema: z.ZodType<AutopilotTrigger> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("limit_exhausted"),
    eventLogId: z.string(),
    lotId: z.string(),
    lotNumber: z.number().int(),
    limitCents: z.number().int(),
    currentBidCents: z.number().int(),
  }),
  z.object({ kind: z.literal("lot_won"), eventLogId: z.string(), lotId: z.string(), lotNumber: z.number().int(), amountCents: z.number().int() }),
  z.object({
    kind: z.literal("lot_lost"),
    eventLogId: z.string(),
    lotId: z.string(),
    lotNumber: z.number().int(),
    winningCents: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("hold_raised"), eventLogId: z.string(), holdId: z.string(), amountCents: z.number().int() }),
  z.object({ kind: z.literal("closing_soon"), lotId: z.string(), lotNumber: z.number().int(), closesAt: z.string() }),
]);

/** Stored reasons as triggers; anything malformed is dropped rather than crashing the tick. */
export function parseTriggers(value: unknown): AutopilotTrigger[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = triggerSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

const asNumber = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * The trigger an event_log row is, or null when it never wakes Glim (§3.1, §3.2): Glim's limit
 * ran out; a lot of the mandate closed, won or lost; a new hold was authorized. Public rows,
 * outbids, limit set/raised/removed/blocked, pauses, the event closing, refused holds and
 * autopilot's own rows are ignored.
 */
export function classifyFact(
  row: { id: string; type: string; payload: unknown },
  mandateLotIds: ReadonlySet<string>,
): AutopilotTrigger | null {
  if (typeof row.payload !== "object" || row.payload === null) return null;
  const payload = row.payload as Record<string, unknown>;
  const kind = asString(payload.kind);
  if (kind?.startsWith("autopilot_")) return null;
  const lotId = asString(payload.lotId);
  const lotNumber = asNumber(payload.lotNumber);
  if (row.type === "glim" && kind === "limit_exhausted" && payload.owner === "glim" && lotId && lotNumber !== null) {
    const limitCents = asNumber(payload.limitCents);
    const currentBidCents = asNumber(payload.currentBidCents);
    if (limitCents === null || currentBidCents === null) return null;
    return { kind: "limit_exhausted", eventLogId: row.id, lotId, lotNumber, limitCents, currentBidCents };
  }
  if (row.type === "lot_closed" && lotId && lotNumber !== null && mandateLotIds.has(lotId)) {
    if (kind === "lot_won") {
      const amountCents = asNumber(payload.amountCents);
      return amountCents === null ? null : { kind: "lot_won", eventLogId: row.id, lotId, lotNumber, amountCents };
    }
    if (kind === "lot_lost") {
      return { kind: "lot_lost", eventLogId: row.id, lotId, lotNumber, winningCents: asNumber(payload.winningCents) };
    }
  }
  if (row.type === "hold" && payload.status === "authorized") {
    const holdId = asString(payload.holdId);
    const amountCents = asNumber(payload.amountCents);
    if (holdId && amountCents !== null) return { kind: "hold_raised", eventLogId: row.id, holdId, amountCents };
  }
  return null;
}

export interface ScanResult {
  /** Rows read past the cursors. */
  rows: number;
  triggers: number;
}

type ScanRow = { paddle_id: string; cursor: string; id: string; type: string; payload: unknown; mandate: unknown };

/**
 * Reads armed paddles' new event_log rows (simulated paddles, events that are not live and plans
 * that are not active with a mandate are never read) and, per paddle, advances the cursor past
 * every row read, appends the triggers to reasons and opens a one-second debounce window. The
 * update is guarded by the cursor it read, so two scanners can never apply the same rows twice.
 */
export async function scanFacts(db: Queryable, { limit = SCAN_LIMIT }: { limit?: number } = {}): Promise<ScanResult> {
  const { rows } = await db.query<ScanRow>(
    `select a.paddle_id, a.cursor_event_log_id::text as cursor, el.id::text as id, el.type, el.payload, p.mandate
     from glim_autopilot a
     join paddles pd on pd.id = a.paddle_id and not pd.is_simulated
     join events e on e.id = a.event_id and e.status = 'live'
     join glim_plans p on p.paddle_id = a.paddle_id and p.status = 'active' and p.mandate is not null
     join event_log el on el.paddle_id = a.paddle_id and el.id > a.cursor_event_log_id
     order by el.id
     limit $1`,
    [limit],
  );
  const byPaddle = new Map<string, ScanRow[]>();
  for (const row of rows) byPaddle.set(row.paddle_id, [...(byPaddle.get(row.paddle_id) ?? []), row]);

  let triggers = 0;
  for (const [paddleId, paddleRows] of byPaddle) {
    const first = paddleRows[0];
    const last = paddleRows.at(-1);
    if (!first || !last) continue;
    const mandate = parseMandate(first.mandate);
    const lotIds = new Set(mandate?.lots.map((lot) => lot.lotId) ?? []);
    const found = paddleRows.flatMap((row) => {
      const trigger = classifyFact(row, lotIds);
      return trigger ? [trigger] : [];
    });
    const updated = await db.query(
      `update glim_autopilot set
         cursor_event_log_id = $2::bigint,
         reasons = reasons || $3::jsonb,
         due_at = case when $4 then coalesce(due_at, now() + make_interval(secs => $6)) else due_at end,
         updated_at = now()
       where paddle_id = $1 and cursor_event_log_id = $5::bigint`,
      [paddleId, last.id, JSON.stringify(found), found.length > 0, first.cursor, DEBOUNCE_SECONDS],
    );
    if (updated.rowCount === 1) triggers += found.length;
  }
  return { rows: rows.length, triggers };
}

/**
 * closing_soon (§3.1): a plan lot of an armed paddle closes within 90 s, and the guest either
 * doesn't lead it or leads at exactly Glim's maximum there. Once per lot: lots already reviewed,
 * queued or claimed are left out. The trigger is due at once.
 */
export async function scanClosingSoon(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ paddle_id: string; lot_id: string; lot_number: number; closes_at: Date }>(
    `select a.paddle_id, l.id as lot_id, l.number as lot_number, l.closes_at
     from glim_autopilot a
     join paddles pd on pd.id = a.paddle_id and not pd.is_simulated
     join events e on e.id = a.event_id and e.status = 'live'
     join glim_plans p on p.paddle_id = a.paddle_id and p.status = 'active' and p.mandate is not null
     join glim_plan_items i on i.plan_id = p.id and i.status <> 'skipped'
     join lots l on l.id = i.lot_id and l.status = 'open'
       and l.closes_at > now() and l.closes_at <= now() + make_interval(secs => $1)
     left join bid_limits bl on bl.lot_id = l.id and bl.paddle_id = a.paddle_id and bl.active and bl.owner = 'glim'
     where (l.high_paddle_id is distinct from a.paddle_id or (bl.id is not null and l.current_bid_cents = bl.max_cents))
       and not (a.closing_reviewed ? l.id::text)
       and not exists (
         select 1 from jsonb_array_elements(a.reasons || a.claimed_reasons) r
         where r->>'kind' = 'closing_soon' and r->>'lotId' = l.id::text
       )`,
    [CLOSING_SOON_SECONDS],
  );
  for (const row of rows) {
    const trigger: AutopilotTrigger = {
      kind: "closing_soon",
      lotId: row.lot_id,
      lotNumber: row.lot_number,
      closesAt: row.closes_at.toISOString(),
    };
    await db.query(
      `update glim_autopilot set reasons = reasons || $2::jsonb, due_at = now(), updated_at = now() where paddle_id = $1`,
      [row.paddle_id, JSON.stringify([trigger])],
    );
  }
  return rows.length;
}

export interface AutopilotClaim {
  paddleId: string;
  eventId: string;
  reasons: AutopilotTrigger[];
  attempts: number;
  /** running_since as claimed; release and requeue only touch a lease that is still this one. */
  lease: Date;
}

/**
 * Claims up to `limit` paddles whose debounce has passed (§3.3), one run per paddle: the claim
 * takes a 60-second lease and moves the reasons into claimed_reasons. A lease that expired (the
 * process died mid-run) is taken over with its claimed reasons, even when no new fact arrived.
 */
export async function claimDue(db: Queryable, { limit }: { limit: number }): Promise<AutopilotClaim[]> {
  if (limit <= 0) return [];
  const { rows } = await db.query<{ paddle_id: string; event_id: string; claimed_reasons: unknown; attempts: number; running_since: Date }>(
    // Millisecond precision, so the lease round-trips exactly through a JavaScript Date.
    `update glim_autopilot a set
       running_since = date_trunc('milliseconds', clock_timestamp()), reasons = '[]'::jsonb, due_at = null, updated_at = now(),
       claimed_reasons = case when a.running_since is null then a.reasons else a.claimed_reasons || a.reasons end
     where a.paddle_id in (
       select paddle_id from glim_autopilot
       where (running_since is null and due_at <= now())
          or (running_since < now() - make_interval(secs => $2)
              and (due_at <= now() or claimed_reasons <> '[]'::jsonb))
       order by coalesce(due_at, running_since)
       limit $1
       for update skip locked)
     returning a.paddle_id, a.event_id, a.claimed_reasons, a.attempts, a.running_since`,
    [limit, LEASE_SECONDS],
  );
  return rows.map((row) => ({
    paddleId: row.paddle_id,
    eventId: row.event_id,
    reasons: parseTriggers(row.claimed_reasons),
    attempts: row.attempts,
    lease: row.running_since,
  }));
}

/** Ends a run: clears the lease and its claimed reasons, and marks reviewed closing lots. */
export async function releaseClaim(db: Queryable, claim: AutopilotClaim): Promise<void> {
  const closing = claim.reasons.filter((reason) => reason.kind === "closing_soon").map((reason) => reason.lotId);
  await db.query(
    `update glim_autopilot set
       running_since = null, claimed_reasons = '[]'::jsonb, last_run_at = now(), attempts = 0,
       closing_reviewed = closing_reviewed || $3::jsonb, updated_at = now()
     where paddle_id = $1 and running_since = $2`,
    [claim.paddleId, claim.lease, JSON.stringify(closing)],
  );
}

/**
 * Puts a claim's reasons back for another try after `delayMs` (§3.3). With `countAttempt`, a
 * failed run: after three attempts its reasons are dropped and the failure goes to error_log.
 */
export async function requeueClaim(
  db: Queryable,
  claim: AutopilotClaim,
  options: { delayMs: number; countAttempt: boolean; error?: unknown },
): Promise<void> {
  const attempts = claim.attempts + (options.countAttempt ? 1 : 0);
  if (options.countAttempt && attempts >= MAX_RUN_ATTEMPTS) {
    await db.query(
      `update glim_autopilot set running_since = null, claimed_reasons = '[]'::jsonb, attempts = 0, updated_at = now()
       where paddle_id = $1 and running_since = $2`,
      [claim.paddleId, claim.lease],
    );
    await logError(db, {
      code: "autopilot_run_failed",
      message: `Glim's autopilot gave up after ${MAX_RUN_ATTEMPTS} attempts; its reasons were dropped.`,
      eventId: claim.eventId,
      paddleId: claim.paddleId,
      detail: { reasons: claim.reasons, error: describeError(options.error) },
    });
    return;
  }
  await db.query(
    `update glim_autopilot set
       running_since = null, reasons = claimed_reasons || reasons, claimed_reasons = '[]'::jsonb,
       due_at = least(coalesce(due_at, 'infinity'::timestamptz), clock_timestamp() + make_interval(secs => $3)),
       attempts = $4, updated_at = now()
     where paddle_id = $1 and running_since = $2`,
    [claim.paddleId, claim.lease, options.delayMs / 1000, attempts],
  );
}

function describeError(error: unknown): string | null {
  if (error === undefined) return null;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
