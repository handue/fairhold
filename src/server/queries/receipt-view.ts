/**
 * Screen 11, the receipt, and 25b, its printable page. After bidding closes a guest is in one of four
 * places, and design/25 draws each:
 *
 * - paid: settlement charged them and wrote the receipt snapshot (src/server/settlement/receipt.ts),
 *   which this reads as it was written, so a later edit to a lot cannot change it.
 * - pending: they won lots and the organizer has not charged yet, or a charge failed and waits for a
 *   retry. The figures are what the charge will be, read from the lots as settlement will read them.
 * - released: they won nothing and their hold is no longer held (voided, or simulated and settled).
 * - release_pending: they won nothing and their hold waits for the organizer's charge to release it.
 *
 * Nothing here calls PayPal.
 */
import { getPool } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import type { Queryable } from "@/server/db/transaction";
import { eventHasEnded } from "@/server/engine/rules";
import { readBiddingHold } from "@/server/holds/bidding-hold";
import { deductibleCents, type ReceiptGlimRecap, type ReceiptLine } from "@/server/settlement/receipt";

import type { EventStatus, Instant, LotCategory } from "./types";

export type ReceiptPhase = "paid" | "pending" | "released" | "release_pending";

export interface ReceiptLot {
  lotId: string;
  number: number;
  category: LotCategory;
  title: string;
  coverDrawing: string | null;
  /** Won: when it closed; not won: when it closed. */
  closedAt: Instant | null;
  /** Won lots: what is paid or to pay. */
  paidCents: number;
  estimatedValueCents: number | null;
  deductibleCents: number;
  /** Who placed the paddle's last bid on the lot. */
  bidBy: "glim" | "guest" | null;
  /** Glim's limit behind that bid, when Glim placed it. */
  limitCents: number | null;
  /** The paddle's last bid, on a lot it did not win. */
  lastBidCents: number | null;
  /** What a lot it did not win sold for. */
  soldCents: number | null;
}

export interface ReceiptGlimView {
  bidsPlaced: number;
  allWithinLimits: boolean;
  /** When every bid Glim placed was under one limit: that limit. */
  singleLimitCents: number | null;
  planLots: number;
  planLotsWon: number;
  offDutyAt: Instant;
}

export interface ReceiptView {
  phase: ReceiptPhase;
  event: {
    slug: string;
    name: string;
    charityName: string;
    charityEin: string | null;
    charityIs501c3: boolean;
    timeZone: string;
    status: EventStatus;
    opensAt: Instant;
    /** When bidding really ended: a "Close bidding now" moves it earlier. */
    closesAt: Instant;
    isDemo: boolean;
    pickupNote: string | null;
    /** "PAYPAL *RIVERSIDEGALA": what a PayPal charge shows on a statement. */
    statementLabel: string | null;
  };
  viewer: { paddleNumber: number; firstName: string };
  hold: { cents: number; authorizedAt: Instant | null; authorizationId: string | null } | null;
  payCents: number;
  releaseCents: number;
  deductibleCents: number;
  receipt: { number: string; issuedAt: Instant; captureId: string | null } | null;
  /** When a won-nothing hold was released, if the database knows. */
  releasedAt: Instant | null;
  won: ReceiptLot[];
  notWon: ReceiptLot[];
  /** Null when Glim placed no bids for the paddle: 25 drops its row. */
  glim: ReceiptGlimView | null;
}

const ms = (value: Date | null | undefined): Instant | null => (value ? value.getTime() : null);

interface EventRow {
  id: string;
  slug: string;
  name: string;
  charity_name: string;
  charity_ein: string | null;
  charity_is_501c3: boolean;
  timezone: string;
  status: EventStatus;
  opens_at: Date | null;
  closes_at: Date;
  closed_at: Date | null;
  is_demo: boolean;
  pickup_note: string | null;
  soft_descriptor: string | null;
}

interface LotRow {
  id: string;
  number: number;
  category: LotCategory;
  title: string;
  cover: string | null;
  closed_at: Date | null;
  closes_at: Date;
  winning_paddle_id: string | null;
  winning_cents: number | null;
  estimated_value_cents: number | null;
  /** The paddle's highest bid on the lot, its source, and the limit behind it. */
  my_cents: number | null;
  my_source: string | null;
  my_limit_cents: number | null;
}

interface ReceiptRow {
  number: string;
  issued_at: Date;
  hold_cents: number;
  hold_authorized_at: Date | null;
  paid_cents: number;
  released_cents: number;
  deductible_cents: number;
  paypal_capture_id: string | null;
  lines: ReceiptLine[];
  glim_recap: ReceiptGlimRecap | null;
}

function lotView(lot: LotRow, paddleId: string): ReceiptLot {
  const won = lot.winning_paddle_id === paddleId;
  const paid = won ? (lot.winning_cents ?? 0) : 0;
  const bidBy = lot.my_source === null ? null : lot.my_source === "glim" ? "glim" : "guest";
  return {
    lotId: lot.id,
    number: lot.number,
    category: lot.category,
    title: lot.title,
    coverDrawing: lot.cover,
    closedAt: ms(lot.closed_at ?? lot.closes_at),
    paidCents: paid,
    estimatedValueCents: lot.estimated_value_cents,
    deductibleCents: won ? deductibleCents(paid, lot.estimated_value_cents) : 0,
    bidBy,
    limitCents: bidBy === "glim" ? lot.my_limit_cents : null,
    lastBidCents: won ? null : lot.my_cents,
    soldCents: won ? null : lot.winning_cents,
  };
}

/** A won line of the snapshot, with the drawing the lot shows today. */
function snapshotLot(line: Extract<ReceiptLine, { kind: "won" }>, covers: ReadonlyMap<string, string | null>): ReceiptLot {
  return {
    lotId: line.lotId,
    number: line.lotNumber,
    category: line.category as LotCategory,
    title: line.title,
    coverDrawing: covers.get(line.lotId) ?? null,
    closedAt: line.wonAt ? Date.parse(line.wonAt) : null,
    paidCents: line.paidCents,
    estimatedValueCents: line.estimatedValueCents,
    deductibleCents: line.deductibleCents,
    bidBy: line.bidBy,
    limitCents: line.limitCents,
    lastBidCents: null,
    soldCents: null,
  };
}

/** Which of design/25's places the guest is in. Null while bidding is still open. */
export function receiptPhase(input: {
  status: EventStatus;
  hasReceipt: boolean;
  wonLots: number;
  holdStatus: string | null;
}): ReceiptPhase | null {
  if (!eventHasEnded(input.status)) return null;
  if (input.hasReceipt) return "paid";
  if (input.wonLots > 0) return "pending";
  return input.holdStatus === "authorized" ? "release_pending" : "released";
}

/** Glim's bids for the paddle, live: the same counts the snapshot's glim_recap stores. */
async function readGlim(db: Queryable, paddleId: string, offDutyAt: Instant): Promise<ReceiptGlimView | null> {
  const [bids, plan] = await Promise.all([
    db.query<{ placed: number; over_limit: number; limits: number[] }>(
      `select count(*)::int as placed,
         count(*) filter (where bl.id is null or b.amount_cents > bl.max_cents)::int as over_limit,
         coalesce(array_agg(distinct bl.max_cents) filter (where bl.id is not null), '{}')::int[] as limits
       from bids b
       left join bid_limits bl on bl.id = b.limit_id
       where b.paddle_id = $1 and b.source = 'glim'`,
      [paddleId],
    ),
    db.query<{ plan_lots: number; plan_lots_won: number }>(
      `select count(distinct i.lot_id)::int as plan_lots,
         count(distinct i.lot_id) filter (where l.winning_paddle_id = $1)::int as plan_lots_won
       from glim_plan_items i
       join glim_plans p on p.id = i.plan_id
       join lots l on l.id = i.lot_id
       where p.paddle_id = $1 and p.status in ('active', 'paused', 'ended') and i.status <> 'skipped'`,
      [paddleId],
    ),
  ]);
  const placed = bids.rows[0]?.placed ?? 0;
  if (placed === 0) return null;
  const limits = bids.rows[0]?.limits ?? [];
  return {
    bidsPlaced: placed,
    allWithinLimits: (bids.rows[0]?.over_limit ?? 0) === 0,
    singleLimitCents: limits.length === 1 ? (limits[0] ?? null) : null,
    planLots: plan.rows[0]?.plan_lots ?? 0,
    planLotsWon: plan.rows[0]?.plan_lots_won ?? 0,
    offDutyAt,
  };
}

/**
 * The receipt of paddle `paddleNumber` at event `slug`. Null when the event or paddle is unknown;
 * `phase` null while bidding is open.
 */
export async function getReceiptView(
  query: { slug: string; paddleNumber: number },
  db: Queryable = getPool(),
): Promise<(Omit<ReceiptView, "phase"> & { phase: ReceiptPhase | null }) | null> {
  if (holdsNul(query.slug)) return null;
  const { rows: events } = await db.query<EventRow>(
    `select id, slug, name, charity_name, charity_ein, charity_is_501c3, timezone, status::text as status, opens_at,
       closes_at, closed_at, is_demo, pickup_note, soft_descriptor
     from events where slug = $1`,
    [query.slug],
  );
  const event = events[0];
  if (!event) return null;
  const { rows: paddles } = await db.query<{ id: string; number: number; first_name: string }>(
    "select id, number, first_name from paddles where event_id = $1 and number = $2",
    [event.id, query.paddleNumber],
  );
  const paddle = paddles[0];
  if (!paddle) return null;

  const [receipts, hold, lots, released] = await Promise.all([
    db.query<ReceiptRow>(
      `select number, issued_at, hold_cents, hold_authorized_at, paid_cents, released_cents, deductible_cents,
         paypal_capture_id, lines, glim_recap
       from receipts where event_id = $1 and paddle_id = $2`,
      [event.id, paddle.id],
    ),
    // The hold the paddle bid within, or the one settlement charged or released: never an approval
    // PayPal authorized that was refused as bidding power and voided.
    readBiddingHold(db, paddle.id),
    db.query<LotRow>(
      `select l.id::text as id, l.number, l.category::text as category, l.title, cover.illustration_key as cover,
         l.closed_at, l.closes_at, l.winning_paddle_id::text as winning_paddle_id, l.winning_cents, l.estimated_value_cents,
         mine.amount_cents as my_cents, mine.source::text as my_source, mine.max_cents as my_limit_cents
       from lots l
       left join lot_photos cover on cover.id = l.cover_photo_id
       left join lateral (
         select b.amount_cents, b.source, bl.max_cents
         from bids b left join bid_limits bl on bl.id = b.limit_id
         where b.lot_id = l.id and b.paddle_id = $2
         order by b.amount_cents desc
         limit 1
       ) mine on true
       where l.event_id = $1 and l.status = 'closed' and (l.winning_paddle_id = $2 or mine.amount_cents is not null)
       order by l.number`,
      [event.id, paddle.id],
    ),
    db.query<{ completed_at: Date | null }>(
      `select i.completed_at from settlement_items i
       where i.paddle_id = $1 and i.status = 'succeeded'
       order by i.completed_at desc nulls last limit 1`,
      [paddle.id],
    ),
  ]);

  const receipt = receipts.rows[0] ?? null;
  const closesAt = (event.closed_at ?? event.closes_at).getTime();
  const allLots = lots.rows.map((lot) => lotView(lot, paddle.id));
  const covers = new Map(lots.rows.map((lot) => [lot.id, lot.cover]));
  const wonIds = new Set(lots.rows.filter((lot) => lot.winning_paddle_id === paddle.id).map((lot) => lot.id));
  const wonLive = allLots.filter((lot) => wonIds.has(lot.lotId));
  const notWon = allLots.filter((lot) => !wonIds.has(lot.lotId));
  const phase = receiptPhase({ status: event.status, hasReceipt: receipt !== null, wonLots: wonLive.length, holdStatus: hold?.status ?? null });

  const wonLines = receipt?.lines.filter((line): line is Extract<ReceiptLine, { kind: "won" }> => line.kind === "won") ?? null;
  const won = wonLines ? wonLines.map((line) => snapshotLot(line, covers)) : wonLive;
  const holdCents = receipt?.hold_cents ?? hold?.amountCents ?? 0;
  const payCents = receipt?.paid_cents ?? won.reduce((sum, lot) => sum + lot.paidCents, 0);

  return {
    phase,
    event: {
      slug: event.slug,
      name: event.name,
      charityName: event.charity_name,
      charityEin: event.charity_ein,
      charityIs501c3: event.charity_is_501c3,
      timeZone: event.timezone,
      status: event.status,
      opensAt: (event.opens_at ?? event.closes_at).getTime(),
      closesAt,
      isDemo: event.is_demo,
      pickupNote: event.pickup_note,
      statementLabel: event.soft_descriptor ? `PAYPAL *${event.soft_descriptor}` : null,
    },
    viewer: { paddleNumber: paddle.number, firstName: paddle.first_name },
    hold:
      receipt || hold
        ? {
            cents: holdCents,
            authorizedAt: ms(receipt?.hold_authorized_at ?? hold?.authorizedAt),
            authorizationId: hold?.originalAuthorizationId ?? null,
          }
        : null,
    payCents,
    releaseCents: receipt?.released_cents ?? Math.max(0, holdCents - payCents),
    deductibleCents: receipt?.deductible_cents ?? won.reduce((sum, lot) => sum + lot.deductibleCents, 0),
    receipt: receipt ? { number: receipt.number, issuedAt: receipt.issued_at.getTime(), captureId: receipt.paypal_capture_id } : null,
    releasedAt: ms(released.rows[0]?.completed_at),
    won,
    notWon,
    glim: await readGlim(db, paddle.id, closesAt),
  };
}
