/**
 * Ending a demo for good, by the Reset control or at its 6-hour limit: bidding closes through the
 * engine, the event leaves settlement's reach, and the director's plans for it are dropped. After
 * that its authorizations can be voided, and no bid, late approval or settlement can touch them.
 */
import type pg from "pg";

import { withTransaction } from "@/server/db/transaction";
import { closeEvent } from "@/server/engine";

import { cancelQueuedJobs } from "./jobs";

export type RetireResult =
  /** Nothing can charge or bid on this event any more. */
  | "retired"
  /** A settlement is still working through it; a void now could race one of its captures. */
  | "settlement_running";

/**
 * closed becomes settled, so startSettlement, which needs closed, refuses it; a settlement that ran
 * and ended (even with errors) counts as over. Changing the event's status waits for any hold swap
 * holding the event row FOR SHARE, and a later swap reads the event as ended and is refused.
 *
 * Call it inside a transaction. The lock comes first and the update's read second, so it sees what a
 * Retry holding this row FOR SHARE did: a settlement reopened by then is still running, and a Retry
 * that comes later finds the event settled and refuses.
 */
export async function fenceSettlement(client: pg.PoolClient, eventId: string): Promise<RetireResult> {
  await client.query("select id from events where id = $1 for no key update", [eventId]);
  await client.query(
    `update events e set status = 'settled', settled_at = coalesce(e.settled_at, now())
     where e.id = $1 and (e.status = 'closed' or (e.status = 'settling'
       and exists (select 1 from settlements s where s.event_id = e.id and s.status <> 'running')))`,
    [eventId],
  );
  const { rows } = await client.query<{ status: string }>("select status from events where id = $1", [eventId]);
  return rows[0]?.status === "settling" ? "settlement_running" : "retired";
}

/** Safe to repeat: every step leaves an already retired demo as it is. */
export async function retireDemo(pool: pg.Pool, eventId: string): Promise<RetireResult> {
  await closeEvent(eventId, { pool });
  await cancelQueuedJobs(pool, eventId);
  return withTransaction(pool, (client) => fenceSettlement(client, eventId));
}
