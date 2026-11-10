/**
 * getInsightsView: the organizer's "Tonight" report (design/28), read from the database on the same
 * figures as 12. It starts from the ledger's own view, so the two pages cannot disagree, and adds
 * what only Insights shows: every lot, the bids over the evening and Glim's limits.
 */
import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";

import { getLedgerView } from "./ledger";
import type { InsightsLot, InsightsView, RaisedPoint } from "./types";

/** "Raised through the evening" and its sparkline: the evening in 15 equal steps, as drawn. */
export const RAISED_STEPS = 15;

interface LotRow {
  id: string;
  number: number;
  title: string;
  status: "draft" | "open" | "closed";
  estimated_value_cents: number | null;
  bid_count: number;
  amount_cents: number | null;
  paddle_number: number | null;
  glim: boolean;
}

interface BidRow {
  lot_id: string;
  amount_cents: number;
  at: Date;
}

interface LimitRow {
  max_cents: number;
  highest_cents: number | null;
}

/** The report of the event `slug`, or null when there is no such event. */
export async function getInsightsView(slug: string, db: Queryable = getPool()): Promise<InsightsView | null> {
  const ledger = await getLedgerView(slug, db);
  if (!ledger) return null;

  const [lots, bids, limits, glimBids] = await Promise.all([
    db.query<LotRow>(
      `select l.id, l.number, l.title, l.status, l.estimated_value_cents, l.bid_count,
         case when l.status = 'closed' then l.winning_cents else l.current_bid_cents end as amount_cents,
         p.number as paddle_number,
         coalesce((select b.source = 'glim' from bids b
                   where b.lot_id = l.id and b.paddle_id = p.id
                   order by b.amount_cents desc limit 1), false) as glim
       from lots l
       join events e on e.id = l.event_id
       left join paddles p on p.id = case when l.status = 'closed' then l.winning_paddle_id else l.high_paddle_id end
       where e.slug = $1 and l.status <> 'draft'
       order by l.number`,
      [slug],
    ),
    db.query<BidRow>(
      `select b.lot_id, b.amount_cents, b.created_at as at
       from bids b join lots l on l.id = b.lot_id join events e on e.id = l.event_id
       where e.slug = $1
       order by b.created_at, b.amount_cents`,
      [slug],
    ),
    db.query<LimitRow>(
      `select bl.max_cents,
         (select max(b.amount_cents) from bids b where b.limit_id = bl.id and b.source = 'glim') as highest_cents
       from bid_limits bl
       join lots l on l.id = bl.lot_id
       join events e on e.id = l.event_id
       where e.slug = $1 and bl.owner = 'glim'`,
      [slug],
    ),
    db.query<{ total: number; within: number }>(
      `select count(*)::int as total,
         count(*) filter (where bl.id is not null and bl.paddle_id = b.paddle_id and bl.lot_id = b.lot_id
                            and b.amount_cents <= bl.max_cents)::int as within
       from bids b
       join lots l on l.id = b.lot_id
       join events e on e.id = l.event_id
       left join bid_limits bl on bl.id = b.limit_id
       where e.slug = $1 and b.source = 'glim'`,
      [slug],
    ),
  ]);

  const live = ledger.phase === "live";
  const opensAt = ledger.event.opensAt;
  const closesAt = ledger.event.closesAt;
  const end = live ? Math.min(Math.max(ledger.now, opensAt), closesAt) : closesAt;

  const lotRows: InsightsLot[] = lots.rows.map((lot) => ({
    number: lot.number,
    title: lot.title,
    amountCents: lot.amount_cents,
    estimatedValueCents: lot.estimated_value_cents,
    bids: lot.bid_count,
    paddleNumber: lot.paddle_number,
    glim: lot.glim,
    closed: lot.status === "closed",
  }));

  const winnerRows = ledger.rows.filter((row) => row.toChargeCents > 0);
  const chargedCents = ledger.totals.toChargeCents;
  const shares = limits.rows.map((limit) => (limit.highest_cents ?? 0) / limit.max_cents).sort((a, b) => b - a);

  return {
    event: ledger.event,
    phase: ledger.phase,
    now: ledger.now,
    bidders: ledger.counts.all,
    simulatedBidders: ledger.holds.simulated,
    saySimulated: ledger.holds.simulated > 0 && (ledger.event.isDemo || ledger.holds.real > 0),
    raisedCents: lotRows.reduce((sum, lot) => sum + (lot.amountCents ?? 0), 0),
    raised: raisedSeries(bids.rows, opensAt, end, closesAt),
    window: { opensAt, closesAt },
    lots: {
      total: ledger.lots.total,
      sold: ledger.lots.sold,
      open: lotRows.filter((lot) => !lot.closed).length,
      withoutBids: ledger.lots.withoutBids,
    },
    bids: { total: bids.rows.length, glim: glimBids.rows[0]?.total ?? 0 },
    winners: { count: ledger.counts.winners, glim: ledger.glim.winners },
    limits: {
      shares,
      reached: limits.rows.filter((limit) => (limit.highest_cents ?? 0) >= limit.max_cents).length,
      passed: limits.rows.filter((limit) => (limit.highest_cents ?? 0) > limit.max_cents).length,
      glimBids: glimBids.rows[0]?.total ?? 0,
      glimBidsWithin: glimBids.rows[0]?.within ?? 0,
    },
    holds: {
      heldCents: ledger.totals.heldCents,
      chargedCents,
      winnerHoldCents: winnerRows.reduce((sum, row) => sum + row.heldCents, 0),
      winnerShares: winnerRows
        .filter((row) => row.heldCents > 0)
        .map((row) => row.toChargeCents / row.heldCents)
        .sort((a, b) => b - a),
      nonWinners: ledger.counts.nonWinners,
    },
    lotRows,
  };
}

/**
 * The high bids on every lot added up, at RAISED_STEPS + 1 even instants from the open to the close.
 * While bidding runs the points stop at now, which then ends the line. Bids on a lot only rise, so a
 * lot's latest bid at an instant is its high bid then.
 */
export function raisedSeries(
  bids: readonly { lot_id: string; amount_cents: number; at: Date }[],
  opensAt: number,
  end: number,
  closesAt: number,
): RaisedPoint[] {
  const step = Math.max(1, closesAt - opensAt) / RAISED_STEPS;
  const instants: number[] = [];
  for (let index = 0; index <= RAISED_STEPS; index += 1) {
    const at = opensAt + step * index;
    if (at >= end) break;
    instants.push(at);
  }
  instants.push(end);

  const high = new Map<string, number>();
  let total = 0;
  let next = 0;
  return instants.map((at) => {
    while (next < bids.length && (bids[next]?.at.getTime() ?? Infinity) <= at) {
      const bid = bids[next];
      next += 1;
      if (!bid) continue;
      const before = high.get(bid.lot_id) ?? 0;
      if (bid.amount_cents > before) {
        total += bid.amount_cents - before;
        high.set(bid.lot_id, bid.amount_cents);
      }
    }
    return { at: Math.round(at), cents: total };
  });
}
