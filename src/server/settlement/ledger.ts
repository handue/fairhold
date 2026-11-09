/**
 * getLedger: what 12 shows, read from the database with no call to PayPal. The grid and the rail are
 * both built from this one view, so their figures cannot disagree.
 */
import { getPool } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import type { Queryable } from "@/server/db/transaction";
import { eventHasEnded } from "@/server/engine/rules";
import { parseMandate } from "@/server/glim/mandate";
import { getDevelopmentSwitches } from "@/server/lib/env";
import type { EventStatus } from "@/server/queries/types";

import { checkGlimWithinLimits, checkWinnersWithinHolds, summarizeChecks } from "./checks";
import { bidderName, lotsWonLabel } from "./names";
import type {
  CheckKey,
  HoldKindLabel,
  LedgerGlim,
  LedgerItem,
  LedgerPhase,
  LedgerRow,
  LedgerSettlement,
  LedgerView,
  SettlementCheck,
  SettlementChecks,
  SettlementItemStatus,
  SettlementStatus,
} from "./types";

interface EventRow {
  id: string;
  slug: string;
  name: string;
  charity_name: string;
  timezone: string;
  status: EventStatus;
  opens_at: Date | null;
  closes_at: Date;
  closed_at: Date | null;
  is_demo: boolean;
}

interface PaddleRow {
  id: string;
  number: number;
  first_name: string;
  last_initial: string | null;
  hold_kind: HoldKindLabel | null;
  hold_cents: number | null;
  item_id: string | null;
  action: LedgerItem["action"] | null;
  item_status: SettlementItemStatus | null;
  item_amount_cents: number | null;
  item_released_cents: number | null;
  paypal_capture_id: string | null;
  error_code: string | null;
}

interface LotRow {
  number: number;
  title: string;
  short_title: string;
  status: "draft" | "open" | "closed";
  bid_count: number;
  high_paddle_id: string | null;
  current_bid_cents: number | null;
  winning_paddle_id: string | null;
  winning_cents: number | null;
}

interface SettlementRow {
  id: string;
  status: SettlementStatus;
  started_at: Date;
  finished_at: Date | null;
  winners: number;
  checks: SettlementChecks | null;
  receipts: number;
}

/** The ledger of the event `slug`, or null when there is no such event. */
export async function getLedgerView(slug: string, db: Queryable = getPool()): Promise<LedgerView | null> {
  if (holdsNul(slug)) return null;
  const { rows: events } = await db.query<EventRow>(
    `select id, slug, name, charity_name, timezone, status, opens_at, closes_at, closed_at, is_demo
     from events where slug = $1`,
    [slug],
  );
  const event = events[0];
  if (!event) return null;

  // First: a settlement only reads done after its last row, so rows read later can never lag a "done"
  // and leave 12 reading "charged" over rows still "Queued", with nothing left polling to correct it.
  const settlements = await db.query<SettlementRow>(
    `select s.id, s.status, s.started_at, s.finished_at, s.winners, s.checks,
       (select count(*)::int from receipts r where r.event_id = s.event_id) as receipts
     from settlements s where s.event_id = $1`,
    [event.id],
  );
  const [paddles, lots, glimBids, glimDecisions, glimWithin, now] = await Promise.all([
    db.query<PaddleRow>(
      `select p.id, p.number, p.first_name, p.last_initial, h.kind as hold_kind, h.amount_cents as hold_cents,
         i.id as item_id, i.action, i.status as item_status, i.amount_cents as item_amount_cents,
         i.released_cents as item_released_cents, i.paypal_capture_id, i.error_code
       from paddles p
       left join settlement_items i on i.paddle_id = p.id
       left join holds h on h.event_id = p.event_id and h.paddle_id = p.id
         and (h.id = i.hold_id or (i.id is null and h.status = 'authorized'))
       where p.event_id = $1
       order by p.number`,
      [event.id],
    ),
    db.query<LotRow>(
      `select number, title, short_title, status, bid_count, high_paddle_id, current_bid_cents, winning_paddle_id, winning_cents
       from lots where event_id = $1 and status <> 'draft' order by number`,
      [event.id],
    ),
    db.query<{ paddle_id: string; bids: number }>(
      `select b.paddle_id, count(*)::int as bids
       from bids b join lots l on l.id = b.lot_id
       where l.event_id = $1 and b.source = 'glim'
       group by b.paddle_id`,
      [event.id],
    ),
    readGlimDecisions(db, event.id),
    // While bidding runs the checks wait for the close, but the corner's "all within their limits"
    // is only said once the bids themselves are read back.
    eventHasEnded(event.status) ? null : checkGlimWithinLimits(db, event.id),
    readNow(db),
  ]);

  const biddingOver = eventHasEnded(event.status);
  const glimByPaddle = new Map(glimBids.rows.map((row) => [row.paddle_id, row.bids]));

  // Won once a lot has closed; while it is open, what the paddle would win if bidding ended now.
  const lotsByPaddle = new Map<string, LotRow[]>();
  for (const lot of lots.rows) {
    const holder = lot.status === "closed" ? lot.winning_paddle_id : lot.high_paddle_id;
    if (holder) lotsByPaddle.set(holder, [...(lotsByPaddle.get(holder) ?? []), lot]);
  }

  const rows = paddles.rows.flatMap((paddle): LedgerRow[] => {
    const paddleLots = lotsByPaddle.get(paddle.id) ?? [];
    if (paddle.hold_cents === null && paddleLots.length === 0) return [];
    const wonCents = paddleLots.reduce(
      (sum, lot) => sum + ((lot.status === "closed" ? lot.winning_cents : lot.current_bid_cents) ?? 0),
      0,
    );
    const hasItem = paddle.item_id !== null && paddle.action !== null && paddle.item_status !== null;
    const toChargeCents = hasItem ? (paddle.item_amount_cents ?? 0) : wonCents;
    const toReleaseCents = hasItem ? (paddle.item_released_cents ?? 0) : Math.max(0, (paddle.hold_cents ?? 0) - wonCents);
    return [
      {
        paddleId: paddle.id,
        paddleNumber: paddle.number,
        bidder: bidderName(paddle.first_name, paddle.last_initial),
        lotsWon: lotsWonLabel(paddleLots.map((lot) => ({ title: lot.title, shortTitle: lot.short_title }))),
        lotsWonFull: paddleLots.map((lot) => lot.title).join(", "),
        glim: glimByPaddle.has(paddle.id),
        holdKind: paddle.hold_kind,
        heldCents: hasItem ? toChargeCents + toReleaseCents : (paddle.hold_cents ?? 0),
        toChargeCents,
        toReleaseCents,
        item: hasItem
          ? {
              id: paddle.item_id as string,
              action: paddle.action as LedgerItem["action"],
              status: paddle.item_status as SettlementItemStatus,
              paypalCaptureId: paddle.paypal_capture_id,
              errorCode: paddle.error_code,
            }
          : null,
      },
    ];
  });
  rows.sort((a, b) => b.toChargeCents - a.toChargeCents || a.paddleNumber - b.paddleNumber);

  const winners = rows.filter((row) => row.toChargeCents > 0);
  const settlementRow = settlements.rows[0];
  const settlement = settlementRow ? summarizeSettlement(settlementRow, rows) : null;
  const glimBidders = rows.filter((row) => row.glim);
  const real = rows.filter((row) => row.holdKind === "paypal").length;
  const checks = settlementRow?.checks ?? (await viewChecks(db, event.id, biddingOver, real));
  const glimCheck = glimWithin ?? checks.checks.find((check) => check.key === "glim_within_limits");
  const glim: LedgerGlim = {
    bidders: glimBidders.length,
    winners: glimBidders.filter((row) => row.toChargeCents > 0).length,
    bids: [...glimByPaddle.values()].reduce((sum, bids) => sum + bids, 0),
    bidsOutsideLimits: glimCheck?.problems.length ?? 0,
    decisions: glimDecisions.decisions,
    decisionsOutsideRules: glimDecisions.outside,
  };

  return {
    event: {
      slug: event.slug,
      name: event.name,
      charityName: event.charity_name,
      timeZone: event.timezone,
      status: event.status,
      opensAt: (event.opens_at ?? event.closes_at).getTime(),
      // "Close bidding now" ends bidding before its scheduled time; the pill says when it really did.
      closesAt: (event.closed_at ?? event.closes_at).getTime(),
      isDemo: event.is_demo,
      dateLabel: longDate(event.closes_at, event.timezone),
    },
    phase: ledgerPhase(event.status, settlement),
    rows,
    counts: { all: rows.length, winners: winners.length, nonWinners: rows.length - winners.length },
    totals: {
      heldCents: rows.reduce((sum, row) => sum + row.heldCents, 0),
      toChargeCents: rows.reduce((sum, row) => sum + row.toChargeCents, 0),
      toReleaseCents: rows.reduce((sum, row) => sum + row.toReleaseCents, 0),
    },
    lots: {
      total: lots.rows.length,
      closed: lots.rows.filter((lot) => lot.status === "closed").length,
      sold: lots.rows.filter((lot) => lot.status === "closed" && lot.winning_paddle_id !== null).length,
      withoutBids: lots.rows
        .filter((lot) => lot.bid_count === 0 && (lot.status === "closed" || !biddingOver))
        .map((lot) => ({ number: lot.number, title: lot.title })),
    },
    holds: { real, simulated: rows.filter((row) => row.holdKind === "simulated").length },
    glim,
    checks,
    settlement,
    now,
  };
}

/** The clock the pages read: FREEZE_CLOCK_AT outside production, else the database's. */
async function readNow(db: Queryable): Promise<number> {
  const frozen = getDevelopmentSwitches().freezeClockAt;
  if (frozen !== null) return frozen;
  const { rows } = await db.query<{ now: Date }>("select clock_timestamp() as now");
  return rows[0]?.now.getTime() ?? Date.now();
}

interface DecisionRow {
  id: string;
  kind: "autopilot_changed" | "autopilot_raise_prepared";
  amount_cents: number | null;
  detail: unknown;
  mandate: unknown;
  bids: { lotId: string; amountCents: number; maxCents: number | null }[];
  /** When Glim decided; read with `skips`, it says whether a Skip came before the decision. */
  created_at?: Date | string | null;
  /** The guest's Skips on the decision's plan: the lot and when. */
  skips?: { lotId: string; at: string }[] | null;
}

interface DecisionLot {
  lotId: string;
  maxCents: number;
}

/** A plan a decision's action recorded: "after" (the plan it asked for) or "before" (the limits it replaced). */
function decisionLots(detail: unknown, key: "after" | "before" = "after"): DecisionLot[] {
  const lots = (detail as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(lots)) return [];
  return lots.flatMap((lot): DecisionLot[] => {
    const { lotId, maxCents } = (lot ?? {}) as { lotId?: unknown; maxCents?: unknown };
    return typeof lotId === "string" && typeof maxCents === "number" ? [{ lotId, maxCents }] : [];
  });
}

/**
 * R9's exception, as buildChange decides it: a decision that only lowers or drops maximums Glim
 * already held may leave the plan over the budget, since it adds nothing.
 */
function lowerOrDropOnly(detail: unknown, after: readonly DecisionLot[]): boolean {
  const stored = (detail as { lowerOrDropOnly?: unknown } | null)?.lowerOrDropOnly;
  if (typeof stored === "boolean") return stored;
  const before = new Map(decisionLots(detail, "before").map((lot) => [lot.lotId, lot.maxCents]));
  return after.every((lot) => {
    const previous = before.get(lot.lotId);
    return previous !== undefined && lot.maxCents <= previous;
  });
}

/**
 * 21's V6 row: every decision Glim made on its own, read back against the rules on its plan. A
 * decision is outside them when a lot it planned or bid on is not one the guest let Glim use (or one
 * the guest had already skipped), a maximum or a bid is above the guest's cap for that lot or above
 * its limit, the maximums it planned add up to more than the budget the guest named ("Never past
 * $500 in all") unless it only lowered or dropped them, or a raise asks for more than that budget. A
 * lot ruled out by Skip after the decision does not count against it, since the decision could not
 * have known.
 */
export function decisionOutsideRules(decision: Omit<DecisionRow, "id">): boolean {
  const mandate = parseMandate(decision.mandate);
  if (!mandate) return true;
  const decidedAt = decision.created_at ? new Date(decision.created_at).getTime() : null;
  const skippedAt = new Map<string, number>();
  for (const skip of decision.skips ?? []) {
    const at = Date.parse(skip.at);
    if (!Number.isNaN(at)) skippedAt.set(skip.lotId, Math.min(at, skippedAt.get(skip.lotId) ?? at));
  }
  // Skip keeps the lot in mandate.lots and adds it to excludedLotIds. It counts against a decision
  // unless its Skip is on record as coming later.
  const ruledOut = (lotId: string) => {
    if (!mandate.excludedLotIds.includes(lotId)) return false;
    const at = skippedAt.get(lotId);
    return at === undefined || decidedAt === null || at <= decidedAt;
  };
  const capOf = (lotId: string) => mandate.lots.find((lot) => lot.lotId === lotId);
  const outsideLot = (lotId: string, cents: number) => {
    const lot = capOf(lotId);
    return !lot || ruledOut(lotId) || (lot.capCents !== null && cents > lot.capCents);
  };
  const after = decisionLots(decision.detail);
  if (after.some((lot) => outsideLot(lot.lotId, lot.maxCents))) return true;
  if (decision.bids.some((bid) => outsideLot(bid.lotId, bid.amountCents) || bid.maxCents === null || bid.amountCents > bid.maxCents)) {
    return true;
  }
  const plannedCents = after.reduce((sum, lot) => sum + lot.maxCents, 0);
  if (mandate.budgetCents !== null && plannedCents > mandate.budgetCents && !lowerOrDropOnly(decision.detail, after)) return true;
  return (
    decision.kind === "autopilot_raise_prepared" &&
    mandate.budgetCents !== null &&
    decision.amount_cents !== null &&
    decision.amount_cents > mandate.budgetCents
  );
}

async function readGlimDecisions(db: Queryable, eventId: string): Promise<{ decisions: number; outside: number }> {
  const { rows } = await db.query<DecisionRow>(
    // A Skip is the plan_edited action skipLot writes with its lot (src/server/plans/apply.ts).
    `select a.id, a.kind, a.amount_cents, a.detail, gp.mandate, a.created_at,
       coalesce((select json_agg(json_build_object('lotId', b.lot_id, 'amountCents', b.amount_cents, 'maxCents', bl.max_cents))
                 from bids b left join bid_limits bl on bl.id = b.limit_id
                 where b.glim_action_id = a.id and b.source = 'glim'), '[]'::json) as bids,
       coalesce((select json_agg(json_build_object('lotId', s.lot_id, 'at', s.created_at))
                 from glim_actions s
                 where s.plan_id = a.plan_id and s.kind = 'plan_edited' and s.lot_id is not null), '[]'::json) as skips
     from glim_actions a
     join paddles p on p.id = a.paddle_id
     left join glim_plans gp on gp.id = a.plan_id
     where p.event_id = $1 and a.decision = 'executed'
       and a.kind in ('autopilot_changed', 'autopilot_raise_prepared')`,
    [eventId],
  );
  return { decisions: rows.length, outside: rows.filter(decisionOutsideRules).length };
}

function summarizeSettlement(row: SettlementRow, rows: readonly LedgerRow[]): LedgerSettlement {
  const settled = rows.filter((ledgerRow) => ledgerRow.item?.status === "succeeded");
  const releasedInFull = settled.filter((ledgerRow) => ledgerRow.toChargeCents === 0).length;
  const countOf = (...statuses: SettlementItemStatus[]) =>
    rows.filter((ledgerRow) => ledgerRow.item && statuses.includes(ledgerRow.item.status)).length;
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at.getTime(),
    finishedAt: row.finished_at?.getTime() ?? null,
    winners: row.winners,
    winnersSettled: settled.filter((ledgerRow) => ledgerRow.toChargeCents > 0).length,
    chargedCents: settled.reduce((sum, ledgerRow) => sum + ledgerRow.toChargeCents, 0),
    releasedCents: settled.reduce((sum, ledgerRow) => sum + ledgerRow.toReleaseCents, 0),
    failed: countOf("failed"),
    pending: countOf("pending"),
    active: countOf("queued", "processing"),
    releasedInFull,
    receipts: row.receipts,
  };
}

function ledgerPhase(status: EventStatus, settlement: LedgerSettlement | null): LedgerPhase {
  if (!eventHasEnded(status)) return "live";
  if (!settlement) return status === "settled" ? "ended" : "ready";
  if (settlement.status === "done") return "charged";
  return settlement.status === "done_with_errors" ? "failed" : "charging";
}

/**
 * The checks as far as the database can answer. PayPal is only asked when the organizer's page
 * posts to /settlement/checks, so a hold on a real authorization reads undecided here. With only
 * simulated holds there is nothing to ask about.
 */
async function viewChecks(
  db: Queryable,
  eventId: string,
  biddingOver: boolean,
  realHolds: number,
): Promise<SettlementChecks> {
  const undecided = (key: CheckKey, count = 0): SettlementCheck => ({ key, passed: null, count, problems: [] });
  if (!biddingOver) {
    return summarizeChecks([undecided("winners_within_holds"), undecided("glim_within_limits"), undecided("holds_valid")], null);
  }
  const [winners, glim] = await Promise.all([checkWinnersWithinHolds(db, eventId), checkGlimWithinLimits(db, eventId)]);
  const holds: SettlementCheck =
    realHolds === 0 ? { key: "holds_valid", passed: true, count: 0, problems: [] } : undecided("holds_valid", realHolds);
  return summarizeChecks([winners, glim, holds], null);
}

const longDates = new Map<string, Intl.DateTimeFormat>();

/** "Saturday, November 7, 2026" in the event's time zone. */
function longDate(at: Date, timeZone: string): string {
  let formatter = longDates.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    longDates.set(timeZone, formatter);
  }
  return formatter.format(at);
}
