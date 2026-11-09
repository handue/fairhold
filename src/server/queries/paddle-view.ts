/**
 * Screen 10, My paddle: the guest's hold and what is in winning bids, their lots, and Glim's
 * activity. The rows the page reads are 08's (lots, paddle, the viewer's relations), so the
 * browser keeps them current with the same fold (live-records.ts); Glim's plan and feed come with
 * them and the page asks for them again when the paddle's channel says they changed.
 *
 * buildPaddleView is pure: the server and the browser run the same code.
 */
import { formatUsd } from "@/server/glim/money";

import { toEventSummary } from "./event";
import type { LiveRecords } from "./live-records";
import type {
  EventSummary,
  Instant,
  LotCategory,
  LotRecord,
  LotStatus,
  ViewerLotRecord,
  ViewerLotStatus,
  ViewerSummary,
} from "./types";
import { indexViewerLots, summarizeViewer, viewerLotStatus } from "./viewer-summary";

// ---------------------------------------------------------------------------------------------
// Rows

/** One lot of the running plan. */
export interface PaddlePlanItem {
  lotId: string;
  maxCents: number;
  skipped: boolean;
}

/** One line of Glim's activity, as glim_actions recorded it. */
export interface PaddleFeedEntry {
  id: string;
  at: Instant;
  /** The eyebrow's words after the time: "CHEF’S TABLE", "PLAN STARTED", "PAUSED". */
  label: string;
  line: string;
  chip: { kind: "winning"; amountCents: number } | { kind: "closed" } | null;
}

export interface PaddleGlimRecords {
  /** The plan Glim is running or holding, if any. */
  plan: {
    status: "active" | "paused";
    pausedAt: Instant | null;
    /** Start bidding stored a mandate: Glim may move money between lots on its own. */
    armed: boolean;
    items: PaddlePlanItem[];
  } | null;
  /** When the guest first pressed Start bidding. */
  onDutySince: Instant | null;
  /** A plan card would arm the autopilot now (design/21's switch, and GLIM_AUTOPILOT). */
  autopilotOn: boolean;
  /** Newest first. */
  feed: PaddleFeedEntry[];
}

export const NO_GLIM_RECORDS: PaddleGlimRecords = { plan: null, onDutySince: null, autopilotOn: false, feed: [] };

/** 10's rows: 08's, then Glim's, then whether a PayPal window for a raise is open. */
export interface PaddleSeed extends LiveRecords {
  now: Instant;
  glim: PaddleGlimRecords;
  /** A raise is waiting in a PayPal window. */
  raisePending: boolean;
}

// ---------------------------------------------------------------------------------------------
// View

/** "Glim’s limit $380 · reached": the words, the amount in mono, then a muted tail. */
export interface LotNote {
  text: string;
  amountCents: number | null;
  tail: string | null;
}

export interface PaddleLotRow {
  number: number;
  category: LotCategory;
  title: string;
  coverDrawing: string | null;
  status: LotStatus;
  viewerStatus: ViewerLotStatus;
  closesAt: Instant;
  /** Closed and not won: the row goes quiet. */
  done: boolean;
  note: LotNote;
  /** The current bid, the winning amount, or the starting bid before anyone bids. */
  priceCents: number;
  bidCount: number;
  /** For a lot that closed without this paddle winning: what it sold for. */
  soldCents: number | null;
}

export type GlimDuty =
  | { kind: "idle" }
  | { kind: "on"; since: Instant | null }
  | { kind: "paused"; since: Instant | null };

export interface PaddleView {
  serverNow: Instant;
  event: EventSummary;
  viewer: ViewerSummary;
  money: {
    holdCents: number;
    /** Leading bids on open lots and won amounts on closed ones: what bidding ending now would charge. */
    inWinningCents: number;
    leftCents: number;
    /** "Glim’s room on Spa Day", when what is left is what Glim keeps for raises. */
    roomNote: string | null;
    /** Any bid by this paddle, by hand or by Glim: the lime button moves to Raise once there is one. */
    hasBids: boolean;
    raisePending: boolean;
  };
  rows: PaddleLotRow[];
  glim: {
    duty: GlimDuty;
    /** Design/21's two-line rule (Glim decides inside the guest's rules) rather than 10's one line. */
    decides: boolean;
    feed: PaddleFeedEntry[];
  };
}

/** The lots that belong on 10: bid on, under a limit, or in Glim's plan. Hearts alone do not. */
function isMyLot(relation: ViewerLotRecord | undefined, planItem: PaddlePlanItem | undefined): boolean {
  if (planItem && !planItem.skipped) return true;
  if (!relation) return false;
  return relation.hasBid || relation.inGlimPlan || relation.limitCents !== null;
}

function noteFor(input: {
  lot: LotRecord;
  status: ViewerLotStatus;
  relation: ViewerLotRecord | undefined;
  planItem: PaddlePlanItem | undefined;
  paused: boolean;
}): LotNote {
  const { lot, status, relation, planItem, paused } = input;
  const glimLot = (planItem !== undefined && !planItem.skipped) || relation?.inGlimPlan === true;
  const glimMax = glimLot ? (planItem?.maxCents ?? relation?.limitCents ?? null) : null;
  const ownMax = !glimLot ? (relation?.limitCents ?? null) : null;
  const max = glimMax ?? ownMax;

  if (max === null) {
    // A hand bid on a lot Glim has nothing to do with: 10's approved "Not in Glim’s plan · outbid".
    const tail = status === "outbid" || status === "lost" ? "outbid" : status === "won" ? "won" : null;
    return { text: tail ? `Not in Glim’s plan · ${tail}` : "Not in Glim’s plan", amountCents: null, tail: null };
  }

  const text = glimMax !== null ? "Glim’s limit" : "Your max";
  let tail: string | null = null;
  if (lot.status === "closed") tail = status === "won" ? "won" : status === "lost" ? "outbid" : null;
  else if (glimMax !== null && paused) tail = "paused";
  else if (status === "winning") {
    const room = max - (lot.currentBidCents ?? 0);
    tail = room > 0 ? `${formatUsd(room)} of room left` : "reached";
  } else if (status === "outbid") tail = "outbid";
  return { text, amountCents: max, tail };
}

/** Open lots first, next to close first; then closed lots, the latest first. */
function byPaddleOrder(a: PaddleLotRow, b: PaddleLotRow): number {
  const aOpen = a.status === "open";
  const bOpen = b.status === "open";
  if (aOpen !== bOpen) return aOpen ? -1 : 1;
  return aOpen ? a.closesAt - b.closesAt || a.number - b.number : b.closesAt - a.closesAt || a.number - b.number;
}

function joinTitles(titles: readonly string[]): string {
  return titles.length <= 1 ? (titles[0] ?? "") : `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}`;
}

/**
 * "Glim’s room on Spa Day": what is left is no more than the room Glim keeps on the lots it leads
 * (its limit above the current bid), so the guest can see why. Named when one or two lots hold it.
 */
function roomNote(lots: readonly LotRecord[], paddleId: string, plan: PaddleGlimRecords["plan"], leftCents: number): string | null {
  if (!plan || leftCents <= 0) return null;
  const items = new Map(plan.items.filter((item) => !item.skipped).map((item) => [item.lotId, item]));
  const holders = lots.filter((lot) => {
    const item = items.get(lot.id);
    return item && lot.status === "open" && lot.highPaddleId === paddleId && item.maxCents > (lot.currentBidCents ?? 0);
  });
  const room = holders.reduce((sum, lot) => sum + ((items.get(lot.id)?.maxCents ?? 0) - (lot.currentBidCents ?? 0)), 0);
  if (holders.length === 0 || holders.length > 2 || leftCents > room) return null;
  return `Glim’s room on ${joinTitles(holders.map((lot) => lot.shortTitle))}`;
}

export function buildPaddleView(seed: PaddleSeed): PaddleView {
  const { paddle } = seed;
  if (!paddle) throw new Error("My paddle needs a paddle");
  const relations = indexViewerLots(seed.viewerLots);
  const viewer = summarizeViewer(paddle, seed.lots, relations);
  const plan = seed.glim.plan;
  const items = new Map((plan?.items ?? []).map((item) => [item.lotId, item]));
  const paused = plan?.status === "paused";

  let inWinningCents = 0;
  const rows: PaddleLotRow[] = [];
  for (const lot of seed.lots) {
    const relation = relations.get(lot.id);
    const status = viewerLotStatus(lot, paddle.id, relation);
    if (status === "winning") inWinningCents += lot.currentBidCents ?? 0;
    if (status === "won") inWinningCents += lot.winningCents ?? 0;
    const planItem = items.get(lot.id);
    if (!isMyLot(relation, planItem)) continue;

    const closed = lot.status === "closed";
    rows.push({
      number: lot.number,
      category: lot.category,
      title: lot.title,
      coverDrawing: lot.coverDrawing,
      status: lot.status,
      viewerStatus: status,
      closesAt: lot.closesAt,
      done: closed && status !== "won",
      note: noteFor({ lot, status, relation, planItem, paused }),
      priceCents: closed && lot.winningCents !== null ? lot.winningCents : (lot.currentBidCents ?? lot.startingBidCents),
      bidCount: lot.bidCount,
      soldCents: closed && status !== "won" ? lot.winningCents : null,
    });
  }
  rows.sort(byPaddleOrder);

  const holdCents = paddle.holdCents ?? 0;
  const leftCents = Math.max(0, holdCents - inWinningCents);
  const duty: GlimDuty = !plan
    ? { kind: "idle" }
    : plan.status === "paused"
      ? { kind: "paused", since: plan.pausedAt }
      : { kind: "on", since: seed.glim.onDutySince };

  return {
    serverNow: seed.now,
    event: toEventSummary(seed.event),
    viewer,
    money: {
      holdCents,
      inWinningCents,
      leftCents,
      roomNote: roomNote(seed.lots, paddle.id, plan, leftCents),
      hasBids: seed.viewerLots.some((relation) => relation.hasBid),
      raisePending: seed.raisePending,
    },
    rows,
    glim: {
      duty,
      decides: plan ? plan.armed : seed.glim.autopilotOn,
      feed: seed.glim.feed,
    },
  };
}

/**
 * The rows after which 10 reads its page again: what the fold does not carry (Glim's plan and feed,
 * a raise's window), and the close, after which 10 hands over to the receipt.
 */
export function changesPaddlePage(row: { type: string; paddleId: string | null; payload: unknown }, paddleId: string): boolean {
  const kind = (row.payload as { kind?: string }).kind;
  if (row.type === "event_status") return kind === "event_closed";
  if (row.paddleId !== paddleId) return false;
  if (row.type === "hold") return true;
  return row.type === "glim" && (kind === "chat_card" || kind === "plan_status" || kind === "autopilot_finished");
}
