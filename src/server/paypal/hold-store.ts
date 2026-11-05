/**
 * What the PayPal window flow reads and writes about holds. The Postgres implementation follows
 * the data model in docs/planning/scope-map.json (holds, with original and current authorization
 * ids, plus events and paddles). Every status change is guarded by the status it expects, so a
 * webhook backstop and a return page racing each other cannot both apply, and each one writes its
 * paddle-scoped event_log row in the same transaction so the guest's open tabs hear about it.
 */
import { sql, type SQL } from "drizzle-orm";

import { getDb, type Database } from "@/server/db/client";
import { positionalSql } from "@/server/db/positional-sql";
import { COMMITMENTS_SQL, eventHasEnded, type EventStatus } from "@/server/engine";
import { appendEventLog, type EventLogEntry } from "@/server/sse/notify";

import type { PaypalError } from "./errors";
import type { HoldKind, Payer } from "./payments";

/**
 * `replaced` means the hold is not the paddle's bidding power but its authorization may still be
 * live at PayPal: a raise displaced it, or it was refused as bidding power when PayPal authorized
 * it (holdSwapRefusal). It becomes `voided` once PayPal confirms the void.
 */
export type HoldStatus =
  | "pending_approval"
  | "authorized"
  | "replaced"
  | "voided"
  | "captured"
  | "expired"
  | "denied"
  | "canceled"
  | "failed";

export interface HoldRecord {
  id: string;
  eventId: string;
  eventSlug: string | null;
  paddleId: string;
  kind: HoldKind;
  status: HoldStatus;
  amountCents: number;
  paypalOrderId: string | null;
  originalAuthorizationId: string | null;
  currentAuthorizationId: string | null;
}

export interface HoldAuthorization {
  authorizationId: string;
  amountCents: number;
  authorizedAt: Date;
  /** End of PayPal's 3-day honor period; past it, capture needs a reauthorization first. */
  honorUntil: Date;
  expiresAt: Date | null;
  payer: Payer;
  raw: unknown;
}

/** A hold that a raise displaced; its authorization still has to be voided at PayPal. */
export interface ReplacedHold {
  id: string;
  kind: HoldKind;
  originalAuthorizationId: string | null;
}

/** Why an authorized hold did not become the paddle's bidding power, with the figures to explain it. */
export type HoldRefusal =
  /** The event's bidding is over: the hold in place (if any) is the one settlement charges. */
  | { reason: "bidding_ended" }
  /** The paddle already holds this much or more, e.g. an older raise window approved after a larger one. */
  | { reason: "not_a_raise"; currentHoldCents: number }
  /** It would not cover what the paddle has already committed (COMMITMENTS_SQL). */
  | { reason: "below_commitments"; committedCents: number };

export interface HoldSwap {
  eventStatus: EventStatus;
  /** What PayPal authorized for the new hold. */
  amountCents: number;
  /** The paddle's authorized hold right now, if it has one. */
  currentHoldCents: number | null;
  /** The paddle's commitments by COMMITMENTS_SQL, which every authorized hold must cover. */
  committedCents: number;
}

/**
 * Null when a hold PayPal just authorized may become the paddle's bidding power. It must be a
 * raise, cover everything the paddle has committed, and arrive while bidding is open. Otherwise
 * an older, smaller raise window approved after a larger one would shrink the bidding power under
 * bids already placed, and a late approval would swap out the hold settlement charges.
 */
export function holdSwapRefusal(swap: HoldSwap): HoldRefusal | null {
  if (eventHasEnded(swap.eventStatus)) return { reason: "bidding_ended" };
  if (swap.currentHoldCents !== null && swap.amountCents <= swap.currentHoldCents) {
    return { reason: "not_a_raise", currentHoldCents: swap.currentHoldCents };
  }
  if (swap.amountCents < swap.committedCents) {
    return { reason: "below_commitments", committedCents: swap.committedCents };
  }
  return null;
}

export type MarkAuthorizedResult =
  | { kind: "authorized"; replaced: ReplacedHold | null }
  /** Stored as replaced (by the hold in place, if any) with its authorization, which still has to be voided. */
  | { kind: "refused"; refusal: HoldRefusal }
  | { kind: "not_pending"; status: HoldStatus | null };

export type PaypalErrorRecord = ReturnType<PaypalError["toRecord"]>;

export interface HoldStore {
  findHold(holdId: string): Promise<HoldRecord | null>;
  /**
   * One transaction, holding the paddle row lock the engine takes before it reads a hold: unless
   * holdSwapRefusal objects, this hold becomes the paddle's authorized hold (the authorization id
   * stored as both original and current) and the hold it replaces is marked replaced, which keeps
   * the one-authorized-hold-per-paddle index satisfied. A refused hold is marked replaced instead
   * and the hold in place stays.
   */
  markAuthorized(holdId: string, authorization: HoldAuthorization): Promise<MarkAuthorizedResult>;
  /** pending_approval -> denied or failed; false when the hold was no longer pending. */
  markApprovalFailed(holdId: string, status: "denied" | "failed", error: PaypalErrorRecord): Promise<boolean>;
  /** pending_approval -> canceled; false when the hold was no longer pending. */
  markCanceled(holdId: string): Promise<boolean>;
  /** replaced -> voided, once PayPal confirmed the void. */
  markReplacedVoided(holdId: string): Promise<void>;
  /** Keeps the latest PayPal failure on the hold without changing its status. */
  recordPaypalError(holdId: string, error: PaypalErrorRecord): Promise<void>;
}

/** Hold ids arrive in query strings; anything else is not a hold and never reaches SQL. */
const HOLD_ID = /^[A-Za-z0-9-]{1,64}$/;

// A type alias, not an interface: row types must be assignable to Record<string, unknown>.
type HoldRow = {
  id: string;
  event_id: string;
  event_slug: string | null;
  paddle_id: string;
  kind: HoldKind;
  status: HoldStatus;
  amount_cents: number | string;
  paypal_order_id: string | null;
  original_authorization_id: string | null;
  current_authorization_id: string | null;
};

export function createPostgresHoldStore(database?: Database): HoldStore {
  const db = () => database ?? getDb();

  return {
    async findHold(holdId) {
      if (!HOLD_ID.test(holdId)) return null;
      try {
        const result = await db().execute<HoldRow>(sql`
          select h.id::text as id, h.event_id::text as event_id, e.slug as event_slug,
                 h.paddle_id::text as paddle_id, h.kind, h.status, h.amount_cents, h.paypal_order_id,
                 h.original_authorization_id, h.current_authorization_id
          from holds h
          left join events e on e.id = h.event_id
          where h.id = ${holdId}
        `);
        const row = result.rows[0];
        return row ? toHoldRecord(row) : null;
      } catch (error) {
        // A well-formed id that is still not valid for the column type (e.g. not a uuid).
        if (postgresErrorCode(error) === "22P02") return null;
        throw error;
      }
    },

    async markAuthorized(holdId, authorization) {
      return db().transaction(async (tx): Promise<MarkAuthorizedResult> => {
        await tx.execute(sql`set local lock_timeout = '5s'`);
        const found = await tx.execute<{ event_id: string; paddle_id: string }>(sql`
          select event_id::text as event_id, paddle_id::text as paddle_id from holds where id = ${holdId}
        `);
        const hold = found.rows[0];
        if (!hold) return { kind: "not_pending", status: null };

        // The engine's lock order: the paddle row before its holds (src/server/engine/store.ts).
        // While it is held no bid can commit against the hold in place, so the commitments read
        // below still hold at commit.
        await tx.execute(sql`select id from paddles where id = ${hold.paddle_id} for no key update`);
        const locked = await tx.execute<{ status: HoldStatus }>(sql`
          select status from holds where id = ${holdId} for update
        `);
        const status = locked.rows[0]?.status ?? null;
        if (status !== "pending_approval") return { kind: "not_pending", status };

        const current = await lockAuthorizedHold(tx, hold.paddle_id);
        const refusal = holdSwapRefusal({
          eventStatus: await lockEventStatus(tx, hold.event_id),
          amountCents: authorization.amountCents,
          currentHoldCents: current?.amountCents ?? null,
          committedCents: await committedCents(tx, hold.paddle_id),
        });

        if (refusal) {
          const replacedByHoldId = current?.id ?? null;
          await tx.execute(sql`
            update holds set status = 'replaced', replaced_by_hold_id = ${replacedByHoldId},
              ${authorizationColumns(authorization)}
            where id = ${holdId}
          `);
          await appendEventLog(tx, [
            holdEvent(hold, {
              holdId,
              status: "replaced",
              amountCents: authorization.amountCents,
              replacedByHoldId,
              ...refusal,
            }),
          ]);
          return { kind: "refused", refusal };
        }

        // The old hold first: the one-authorized-hold index is checked statement by statement.
        if (current) {
          await tx.execute(sql`
            update holds set status = 'replaced', replaced_by_hold_id = ${holdId} where id = ${current.id}
          `);
        }
        await tx.execute(sql`
          update holds set status = 'authorized', ${authorizationColumns(authorization)} where id = ${holdId}
        `);

        if (authorization.payer.email || authorization.payer.payerId) {
          // The paddle's email comes only from PayPal; a later raise never overwrites the first.
          await tx.execute(sql`
            update paddles set
              email = coalesce(email, ${authorization.payer.email ?? null}),
              paypal_payer_id = coalesce(${authorization.payer.payerId ?? null}, paypal_payer_id)
            where id = ${hold.paddle_id}
          `);
        }

        await appendEventLog(tx, [
          holdEvent(hold, { holdId, status: "authorized", amountCents: authorization.amountCents }),
          ...(current ? [holdEvent(hold, { holdId: current.id, status: "replaced", replacedByHoldId: holdId })] : []),
        ]);

        return {
          kind: "authorized",
          replaced: current
            ? { id: current.id, kind: current.kind, originalAuthorizationId: current.originalAuthorizationId }
            : null,
        };
      });
    },

    async markApprovalFailed(holdId, status, error) {
      return db().transaction(async (tx) => {
        const updated = await tx.execute<{ event_id: string; paddle_id: string }>(sql`
          update holds set
            status = ${status},
            paypal_debug_id = ${error.debugId},
            raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('last_error', ${JSON.stringify(error)}::jsonb),
            last_synced_at = now()
          where id = ${holdId} and status = 'pending_approval'
          returning event_id::text as event_id, paddle_id::text as paddle_id
        `);
        const hold = updated.rows[0];
        if (!hold) return false;
        await appendEventLog(tx, [holdEvent(hold, { holdId, status, code: error.code })]);
        return true;
      });
    },

    async markCanceled(holdId) {
      return db().transaction(async (tx) => {
        const updated = await tx.execute<{ event_id: string; paddle_id: string }>(sql`
          update holds set status = 'canceled', last_synced_at = now()
          where id = ${holdId} and status = 'pending_approval'
          returning event_id::text as event_id, paddle_id::text as paddle_id
        `);
        const hold = updated.rows[0];
        if (!hold) return false;
        await appendEventLog(tx, [holdEvent(hold, { holdId, status: "canceled" })]);
        return true;
      });
    },

    async markReplacedVoided(holdId) {
      await db().transaction(async (tx) => {
        const updated = await tx.execute<{ event_id: string; paddle_id: string }>(sql`
          update holds set status = 'voided', last_synced_at = now()
          where id = ${holdId} and status = 'replaced'
          returning event_id::text as event_id, paddle_id::text as paddle_id
        `);
        const hold = updated.rows[0];
        if (hold) await appendEventLog(tx, [holdEvent(hold, { holdId, status: "voided" })]);
      });
    },

    async recordPaypalError(holdId, error) {
      await db().execute(sql`
        update holds set
          paypal_debug_id = ${error.debugId},
          raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object('last_error', ${JSON.stringify(error)}::jsonb)
        where id = ${holdId}
      `);
    },
  };
}

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

interface AuthorizedHold extends ReplacedHold {
  amountCents: number;
}

/** The paddle's authorized hold, locked; call it with the paddle row already locked. */
async function lockAuthorizedHold(tx: Transaction, paddleId: string): Promise<AuthorizedHold | null> {
  const result = await tx.execute<{
    id: string;
    kind: HoldKind;
    amount_cents: number | string;
    original_authorization_id: string | null;
  }>(sql`
    select id::text as id, kind, amount_cents, original_authorization_id
    from holds where paddle_id = ${paddleId} and status = 'authorized'
    for update
  `);
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        kind: row.kind,
        amountCents: Number(row.amount_cents),
        originalAuthorizationId: row.original_authorization_id,
      }
    : null;
}

/**
 * FOR SHARE holds off a status change of the event (bidding closing, settlement starting) until
 * this transaction ends, so a hold is never swapped under a settlement that already read it.
 */
async function lockEventStatus(tx: Transaction, eventId: string): Promise<EventStatus> {
  const result = await tx.execute<{ status: EventStatus }>(sql`
    select status from events where id = ${eventId} for share
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`Hold of a missing event ${eventId}`);
  return row.status;
}

/** The engine's own commitment rule, so the swap and placeBid agree on what a hold must cover. */
async function committedCents(tx: Transaction, paddleId: string): Promise<number> {
  const result = await tx.execute<{ cents: number | string }>(sql`
    select coalesce(sum(c.commitment_cents), 0)::int as cents
    from (${positionalSql(COMMITMENTS_SQL, [[paddleId]])}) c
  `);
  return Number(result.rows[0]?.cents ?? 0);
}

/** What both outcomes store from PayPal's authorization. */
function authorizationColumns(authorization: HoldAuthorization): SQL {
  return sql`
    amount_cents = ${authorization.amountCents},
    original_authorization_id = ${authorization.authorizationId},
    current_authorization_id = ${authorization.authorizationId},
    authorized_at = ${authorization.authorizedAt},
    honor_until = ${authorization.honorUntil},
    expires_at = ${authorization.expiresAt},
    paypal_debug_id = null,
    raw = ${JSON.stringify(authorization.raw ?? null)}::jsonb,
    last_synced_at = now()`;
}

/** A hold change on the paddle's own channel (holds are private to their guest). */
function holdEvent(
  hold: { event_id: string; paddle_id: string },
  payload: EventLogEntry["payload"],
): EventLogEntry {
  return { eventId: hold.event_id, paddleId: hold.paddle_id, type: "hold", payload };
}

function toHoldRecord(row: HoldRow): HoldRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    eventSlug: row.event_slug,
    paddleId: row.paddle_id,
    kind: row.kind,
    status: row.status,
    amountCents: Number(row.amount_cents),
    paypalOrderId: row.paypal_order_id,
    originalAuthorizationId: row.original_authorization_id,
    currentAuthorizationId: row.current_authorization_id,
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
