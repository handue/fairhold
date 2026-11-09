/**
 * The receipt snapshot, written once when a winner's charge goes through, so later edits to a lot
 * cannot change it. The 11 page reads receipts.lines and glim_recap with the types below.
 */
import { randomUUID } from "node:crypto";

import type { Queryable } from "@/server/db/transaction";

export type ReceiptBidBy = "glim" | "guest";

export interface ReceiptWonLine {
  kind: "won";
  lotId: string;
  lotNumber: number;
  category: string;
  title: string;
  shortTitle: string;
  /** ISO 8601: when the lot closed. */
  wonAt: string | null;
  paidCents: number;
  /** Null when the organizer never set one; the page says so instead of naming a figure. */
  estimatedValueCents: number | null;
  deductibleCents: number;
  bidBy: ReceiptBidBy;
  /** Glim's limit on the lot, when Glim placed the winning bid. */
  limitCents: number | null;
}

export interface ReceiptNotWonLine {
  kind: "not_won";
  lotId: string;
  lotNumber: number;
  category: string;
  title: string;
  shortTitle: string;
  closedAt: string | null;
}

export type ReceiptLine = ReceiptWonLine | ReceiptNotWonLine;

export interface ReceiptGlimRecap {
  bidsPlaced: number;
  /** Every one of those bids stayed within its limit. */
  allWithinLimits: boolean;
  planLots: number;
  planLotsWon: number;
  /** ISO 8601: bidding's end, which is when Glim went off duty. */
  offDutyAt: string | null;
}

/**
 * What a winner may deduct on one lot: what they paid above its estimated value, never below zero.
 * A lot with no estimated value yields nothing: the organizer has not said what it is worth, and
 * calling the whole payment deductible would be a tax claim nobody made.
 */
export function deductibleCents(paidCents: number, estimatedValueCents: number | null): number {
  if (estimatedValueCents === null) return 0;
  return Math.max(0, paidCents - estimatedValueCents);
}

/** "1107-142": the gala's date in its own time zone, and the paddle. */
export function receiptNumber(eventClosesAt: Date, timeZone: string, paddleNumber: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "2-digit", day: "2-digit" }).formatToParts(eventClosesAt);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "00";
  return `${part("month")}${part("day")}-${String(paddleNumber).padStart(3, "0")}`;
}

export interface ReceiptInput {
  eventId: string;
  paddleId: string;
  paddleNumber: number;
  holdCents: number;
  holdAuthorizedAt: Date | null;
  paidCents: number;
  /** PayPal's transaction id; null for a simulated guest. */
  captureId: string | null;
  /** PayPal's time for the charge, when it sent one. */
  issuedAt: Date | null;
}

interface WonRow {
  id: string;
  number: number;
  category: string;
  title: string;
  short_title: string;
  closed_at: Date | null;
  winning_cents: number;
  estimated_value_cents: number | null;
  source: string | null;
  limit_cents: number | null;
}

/** Writes the paddle's receipt inside the caller's transaction; a second write changes nothing. */
export async function writeReceipt(client: Queryable, input: ReceiptInput): Promise<void> {
  const { rows: events } = await client.query<{
    closes_at: Date;
    closed_at: Date | null;
    timezone: string;
    soft_descriptor: string | null;
  }>("select closes_at, closed_at, timezone, soft_descriptor from events where id = $1", [input.eventId]);
  const event = events[0];
  if (!event) throw new Error(`Receipt for a missing event ${input.eventId}`);

  const { rows: won } = await client.query<WonRow>(
    `select l.id, l.number, l.category, l.title, l.short_title, l.closed_at, l.winning_cents, l.estimated_value_cents,
       b.source, bl.max_cents as limit_cents
     from lots l
     left join bids b on b.lot_id = l.id and b.amount_cents = l.winning_cents and b.paddle_id = l.winning_paddle_id
     left join bid_limits bl on bl.id = b.limit_id
     where l.event_id = $1 and l.winning_paddle_id = $2 and l.status = 'closed'
     order by l.number`,
    [input.eventId, input.paddleId],
  );
  const { rows: notWon } = await client.query<Omit<WonRow, "winning_cents" | "estimated_value_cents" | "source" | "limit_cents">>(
    `select distinct l.id, l.number, l.category, l.title, l.short_title, l.closed_at
     from bids b
     join lots l on l.id = b.lot_id
     where b.paddle_id = $1 and l.winning_paddle_id is distinct from $1
     order by l.number`,
    [input.paddleId],
  );

  const wonLines = won.map((lot): ReceiptWonLine => ({
    kind: "won",
    lotId: lot.id,
    lotNumber: lot.number,
    category: lot.category,
    title: lot.title,
    shortTitle: lot.short_title,
    wonAt: lot.closed_at?.toISOString() ?? null,
    paidCents: lot.winning_cents,
    estimatedValueCents: lot.estimated_value_cents,
    deductibleCents: deductibleCents(lot.winning_cents, lot.estimated_value_cents),
    bidBy: lot.source === "glim" ? "glim" : "guest",
    limitCents: lot.source === "glim" ? lot.limit_cents : null,
  }));
  const notWonLines = notWon.map((lot): ReceiptNotWonLine => ({
    kind: "not_won",
    lotId: lot.id,
    lotNumber: lot.number,
    category: lot.category,
    title: lot.title,
    shortTitle: lot.short_title,
    closedAt: lot.closed_at?.toISOString() ?? null,
  }));

  await client.query(
    `insert into receipts (id, event_id, paddle_id, number, issued_at, hold_cents, hold_authorized_at, paid_cents,
       released_cents, deductible_cents, paypal_capture_id, statement_descriptor, lines, glim_recap)
     values ($1, $2, $3, $4, coalesce($5, clock_timestamp()), $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
     on conflict (event_id, paddle_id) do nothing`,
    [
      randomUUID(),
      input.eventId,
      input.paddleId,
      receiptNumber(event.closes_at, event.timezone, input.paddleNumber),
      input.issuedAt,
      input.holdCents,
      input.holdAuthorizedAt,
      input.paidCents,
      Math.max(0, input.holdCents - input.paidCents),
      wonLines.reduce((sum, line) => sum + line.deductibleCents, 0),
      input.captureId,
      event.soft_descriptor,
      JSON.stringify([...wonLines, ...notWonLines]),
      JSON.stringify(await glimRecap(client, input.paddleId, event.closed_at ?? event.closes_at)),
    ],
  );
}

async function glimRecap(client: Queryable, paddleId: string, offDutyAt: Date): Promise<ReceiptGlimRecap | null> {
  const { rows: bids } = await client.query<{ placed: number; over_limit: number }>(
    `select count(*)::int as placed,
       count(*) filter (where bl.id is null or b.amount_cents > bl.max_cents)::int as over_limit
     from bids b
     left join bid_limits bl on bl.id = b.limit_id
     where b.paddle_id = $1 and b.source = 'glim'`,
    [paddleId],
  );
  // A superseded plan was replaced by a later one, and a skipped lot left the plan.
  const { rows: plan } = await client.query<{ plan_lots: number; plan_lots_won: number }>(
    `select count(*)::int as plan_lots, count(*) filter (where l.winning_paddle_id = $1)::int as plan_lots_won
     from glim_plan_items i
     join glim_plans p on p.id = i.plan_id
     join lots l on l.id = i.lot_id
     where p.paddle_id = $1 and p.status in ('active', 'paused', 'ended') and i.status <> 'skipped'`,
    [paddleId],
  );
  const placed = bids[0]?.placed ?? 0;
  const planLots = plan[0]?.plan_lots ?? 0;
  if (placed === 0 && planLots === 0) return null;
  return {
    bidsPlaced: placed,
    allWithinLimits: (bids[0]?.over_limit ?? 0) === 0,
    planLots,
    planLotsWon: plan[0]?.plan_lots_won ?? 0,
    offDutyAt: offDutyAt.toISOString(),
  };
}
