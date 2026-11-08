/**
 * "Charge N winners": the one step from a closed event to a running settlement. Idempotent: a double
 * click, or two organizer tabs, get the one settlement of the event.
 */
import { randomUUID } from "node:crypto";

import { appendEventLog, type EventLogEntry } from "@/server/sse/notify";
import type { EventSettlementStatusPayload, SettlementStartedPayload } from "@/server/sse/types";

import { runSettlementChecks } from "./checks";
import { resolveDependencies, settlementTransaction, type SettlementDependencies } from "./dependencies";
import { bidderName } from "./names";
import { itemRequestId, planSettlement, type PlanHold } from "./plan";
import type { CheckProblem, SettlementChecks } from "./types";

export type StartSettlementResult =
  | { kind: "started" | "already_started"; settlementId: string }
  /** Bidding has not ended, so there is nothing final to charge. */
  | { kind: "bidding_open" }
  /** A demo retired before anyone charged it: its holds were released, not charged. */
  | { kind: "event_ended" }
  /** A check failed, so nothing moved. */
  | { kind: "checks_failed"; checks: SettlementChecks };

export async function startSettlement(
  input: { eventId: string; startedBySessionId: string | null },
  overrides: Partial<SettlementDependencies> = {},
): Promise<StartSettlementResult> {
  const dependencies = resolveDependencies(overrides);
  const { pool } = dependencies;

  const { rows: found } = await pool.query<{ status: string; settlement_id: string | null }>(
    `select e.status, s.id as settlement_id from events e left join settlements s on s.event_id = e.id where e.id = $1`,
    [input.eventId],
  );
  const event = found[0];
  if (!event) throw new Error(`No event ${input.eventId}`);
  if (event.settlement_id) return { kind: "already_started", settlementId: event.settlement_id };
  if (event.status === "settled") return { kind: "event_ended" };
  if (event.status !== "closed") return { kind: "bidding_open" };

  // Before any lock: these reads wait on PayPal. Holds can no longer change: no approval becomes
  // bidding power on a closed event (holdSwapRefusal), and the plan below re-reads them under locks.
  const checks = await runSettlementChecks(input.eventId, dependencies);
  if (!checks.passed) return { kind: "checks_failed", checks };

  return settlementTransaction(pool, async (client): Promise<StartSettlementResult> => {
    // The engine's lock order, paddles before the event. A raise swap holds its paddle row and then
    // waits for the event row FOR SHARE (markAuthorized), so taking the event first could deadlock.
    await client.query("select id from paddles where event_id = $1 order by id for no key update", [input.eventId]);
    const { rows: locked } = await client.query<{ status: string }>(
      "select status from events where id = $1 for no key update",
      [input.eventId],
    );
    if (locked[0]?.status !== "closed") {
      const { rows: settlement } = await client.query<{ id: string }>("select id from settlements where event_id = $1", [
        input.eventId,
      ]);
      if (settlement[0]) return { kind: "already_started", settlementId: settlement[0].id };
      return { kind: locked[0]?.status === "settled" ? "event_ended" : "bidding_open" };
    }

    // The event moves first, and the holds are read after: once this commits no approval can change
    // them, and any approval that got its FOR SHARE lock before us has committed by now.
    await client.query("update events set status = 'settling' where id = $1", [input.eventId]);

    const { rows: holds } = await client.query<{
      paddle_id: string;
      number: number;
      first_name: string;
      last_initial: string | null;
      hold_id: string;
      kind: PlanHold["kind"];
      amount_cents: number;
    }>(
      `select p.id as paddle_id, p.number, p.first_name, p.last_initial, h.id as hold_id, h.kind, h.amount_cents
       from holds h join paddles p on p.id = h.paddle_id
       where h.event_id = $1 and h.status = 'authorized'
       order by p.number`,
      [input.eventId],
    );
    const { rows: wins } = await client.query<{ paddle_id: string; number: number; first_name: string; last_initial: string | null; won_cents: number }>(
      `select p.id as paddle_id, p.number, p.first_name, p.last_initial, sum(l.winning_cents)::int as won_cents
       from lots l join paddles p on p.id = l.winning_paddle_id
       where l.event_id = $1 and l.status = 'closed'
       group by p.id, p.number, p.first_name, p.last_initial`,
      [input.eventId],
    );

    const planned = planSettlement(
      holds.map((hold) => ({
        paddleId: hold.paddle_id,
        paddleNumber: hold.number,
        holdId: hold.hold_id,
        kind: hold.kind,
        holdCents: hold.amount_cents,
      })),
      new Map(wins.map((win) => [win.paddle_id, win.won_cents])),
    );
    if (!planned.ok) {
      // A hold changed after the checks read it. Nothing moved; the rollback undoes the status.
      const name = new Map(wins.map((win) => [win.paddle_id, win]));
      const problems = planned.problems.flatMap((item): CheckProblem[] => {
        const winner = name.get(item.paddleId);
        return winner
          ? [{ paddleNumber: winner.number, bidder: bidderName(winner.first_name, winner.last_initial), code: item.code, blocking: true }]
          : [];
      });
      throw new PlanRefused({
        ...checks,
        passed: false,
        checks: checks.checks.map((check) =>
          check.key === "winners_within_holds" ? { ...check, passed: false, problems } : check,
        ),
      });
    }

    const { plan } = planned;
    const settlementId = randomUUID();
    await client.query(
      `insert into settlements (id, event_id, status, started_by_session_id, to_charge_cents, to_release_cents, winners,
         non_winners, checks)
       values ($1, $2, 'running', $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        settlementId,
        input.eventId,
        input.startedBySessionId,
        plan.toChargeCents,
        plan.toReleaseCents,
        plan.winners,
        plan.nonWinners,
        JSON.stringify(checks),
      ],
    );
    for (const item of plan.items) {
      const id = randomUUID();
      await client.query(
        `insert into settlement_items (id, settlement_id, paddle_id, hold_id, action, amount_cents, released_cents, status,
           paypal_request_id)
         values ($1, $2, $3, $4, $5, $6, $7, 'queued', $8)`,
        [id, settlementId, item.paddleId, item.holdId, item.action, item.amountCents, item.releasedCents, itemRequestId(item.action, id)],
      );
    }

    const settling: EventSettlementStatusPayload = { kind: "event_settling", status: "settling" };
    const started: SettlementStartedPayload = {
      kind: "settlement_started",
      settlementId,
      winners: plan.winners,
      nonWinners: plan.nonWinners,
      toChargeCents: plan.toChargeCents,
      toReleaseCents: plan.toReleaseCents,
    };
    const entries: EventLogEntry[] = [
      { eventId: input.eventId, paddleId: null, type: "event_status", payload: settling },
      { eventId: input.eventId, paddleId: null, type: "settlement", payload: started },
    ];
    await appendEventLog(client, entries);
    return { kind: "started", settlementId };
  }).catch((error: unknown) => {
    if (error instanceof PlanRefused) return { kind: "checks_failed", checks: error.checks };
    throw error;
  });
}

/** Thrown to roll the transaction back, and turned back into a result right after. */
class PlanRefused extends Error {
  constructor(readonly checks: SettlementChecks) {
    super("A winner's total no longer fits a hold");
  }
}
