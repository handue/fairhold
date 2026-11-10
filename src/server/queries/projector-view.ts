/**
 * Screen 14, the projector: what the room sees, with paddle numbers and no names. Public, like the
 * stream's public rows it follows. The lots and the event fold from the stream with 08's fold
 * (live-records.ts); who leads each lot, who has bid and what Glim did fold from the same bids_placed
 * rows here (foldProjectorExtras), so a price and its paddle never disagree.
 *
 * Everything but the reads is pure, so the server and the browser run the same code.
 */
import { eventHasEnded } from "@/server/engine/rules";
import { isAfterPosition, type StreamEvent } from "@/server/sse/types";

import { toEventSummary } from "./event";
import type { LiveRecords } from "./live-records";
import type { EventSummary, Instant, LotCategory, LotRecord } from "./types";

/** The paddle behind a lot's current or winning bid. */
export interface ProjectorLeader {
  paddleNumber: number;
  /** Glim placed that bid for the paddle. */
  byGlim: boolean;
}

export interface ProjectorExtras {
  /** By lot id. */
  leaders: Readonly<Record<string, ProjectorLeader>>;
  /** Paddles that held bidding power or bid. */
  bidderIds: readonly string[];
  /** Paddles Glim has bid for. */
  glimPaddleIds: readonly string[];
  glimBids: number;
  /** Every Glim bid stayed within its limit (the settlement check's rule). */
  glimWithinLimits: boolean;
}

export interface ProjectorSeed extends LiveRecords, ProjectorExtras {
  now: Instant;
  isDemo: boolean;
  pickupNote: string | null;
}

export const NO_PROJECTOR_EXTRAS: ProjectorExtras = {
  leaders: {},
  bidderIds: [],
  glimPaddleIds: [],
  glimBids: 0,
  glimWithinLimits: true,
};

/** The seed's extras with every bids_placed row after its position applied. */
export function foldProjectorExtras(seed: ProjectorSeed, rows: readonly StreamEvent[]): ProjectorExtras {
  const relevant = rows.filter((row) => isAfterPosition(row.id, seed.streamPosition));
  if (relevant.length === 0) return seed;
  const leaders = { ...seed.leaders };
  const bidders = new Set(seed.bidderIds);
  const glimPaddles = new Set(seed.glimPaddleIds);
  let glimBids = seed.glimBids;
  for (const row of relevant) {
    if (row.type !== "bid" || row.payload.kind !== "bids_placed") continue;
    const { payload } = row;
    for (const bid of payload.bids) {
      bidders.add(bid.paddleId);
      if (bid.source === "glim") {
        glimBids += 1;
        glimPaddles.add(bid.paddleId);
      }
    }
    const top = payload.bids.find((bid) => bid.amountCents === payload.currentBidCents);
    leaders[payload.lotId] = { paddleNumber: payload.highPaddleNumber, byGlim: top?.source === "glim" };
  }
  return {
    leaders,
    bidderIds: [...bidders],
    glimPaddleIds: [...glimPaddles],
    glimBids,
    glimWithinLimits: seed.glimWithinLimits,
  };
}

// ---------------------------------------------------------------------------------------------
// View

export type ProjectorPhase = "before" | "live" | "after";

export interface ProjectorLot {
  number: number;
  category: LotCategory;
  title: string;
  coverDrawing: string | null;
  closesAt: Instant;
  /** Live: the current bid, or the starting bid before anyone bids. After: what it sold for. */
  priceCents: number;
  bidCount: number;
  leader: ProjectorLeader | null;
}

/** The label over the board's right column ("16 more lots at 9:30 PM", "Last 3 lots", "19 more lots sold"). */
export type ProjectorListNote =
  | { kind: "more"; count: number; at: Instant; sameTime: boolean }
  | { kind: "last"; count: number }
  | { kind: "sold"; count: number }
  | null;

export interface ProjectorView {
  phase: ProjectorPhase;
  serverNow: Instant;
  event: EventSummary;
  isDemo: boolean;
  pickupNote: string | null;
  lotCount: number;
  soldCount: number;
  bidderCount: number;
  /** Live: leading bids and sold lots. After: the sold lots. */
  raisedCents: number;
  /** The raised card: closing now, first to close, or the top lot. */
  first: ProjectorLot | null;
  /** Up to three more. */
  rows: ProjectorLot[];
  note: ProjectorListNote;
  glim: { guests: number; bids: number; withinLimits: boolean };
}

const BOARD_LOTS = 4;

export function projectorPhase(event: { status: EventSummary["status"]; opensAt: Instant }, now: Instant): ProjectorPhase {
  if (eventHasEnded(event.status)) return "after";
  if (event.status === "draft" || event.status === "scheduled" || now < event.opensAt) return "before";
  return "live";
}

const sameMinute = (a: Instant, b: Instant) => Math.floor(a / 60_000) === Math.floor(b / 60_000);

function card(lot: LotRecord, leaders: ProjectorExtras["leaders"], after: boolean): ProjectorLot {
  const priceCents = after ? (lot.winningCents ?? 0) : (lot.currentBidCents ?? lot.startingBidCents);
  return {
    number: lot.number,
    category: lot.category,
    title: lot.title,
    coverDrawing: lot.coverDrawing,
    closesAt: lot.closesAt,
    priceCents,
    bidCount: lot.bidCount,
    leader: lot.bidCount > 0 ? (leaders[lot.id] ?? null) : null,
  };
}

const byClose = (a: LotRecord, b: LotRecord) => a.closesAt - b.closesAt || a.number - b.number;

export function buildProjectorView(input: {
  records: Pick<ProjectorSeed, "event" | "lots" | "isDemo" | "pickupNote">;
  extras: ProjectorExtras;
  now: Instant;
}): ProjectorView {
  const { records, extras, now } = input;
  const { event, lots } = records;
  const phase = projectorPhase(event, now);
  const sold = lots.filter((lot) => lot.status === "closed" && lot.winningPaddleId !== null);

  let list: LotRecord[];
  let note: ProjectorListNote;
  if (phase === "after") {
    list = [...sold].sort((a, b) => (b.winningCents ?? 0) - (a.winningCents ?? 0) || a.number - b.number);
    note = list.length > BOARD_LOTS ? { kind: "sold", count: list.length - BOARD_LOTS } : null;
  } else {
    list = (phase === "before" ? [...lots] : lots.filter((lot) => lot.status === "open")).sort(byClose);
    const rest = list.slice(BOARD_LOTS);
    const last = rest.at(-1);
    if (phase === "live" && list.length <= BOARD_LOTS) note = list.length > 0 ? { kind: "last", count: list.length } : null;
    else if (last) note = { kind: "more", count: rest.length, at: last.closesAt, sameTime: rest.every((lot) => sameMinute(lot.closesAt, last.closesAt)) };
    else note = null;
  }
  const shown = list.slice(0, BOARD_LOTS).map((lot) => card(lot, extras.leaders, phase === "after"));

  const raisedCents = lots.reduce(
    (sum, lot) => sum + (lot.status === "closed" ? (lot.winningCents ?? 0) : phase === "live" ? (lot.currentBidCents ?? 0) : 0),
    0,
  );

  return {
    phase,
    serverNow: now,
    event: toEventSummary(event),
    isDemo: records.isDemo,
    pickupNote: records.pickupNote,
    lotCount: lots.length,
    soldCount: sold.length,
    bidderCount: extras.bidderIds.length,
    raisedCents,
    first: shown[0] ?? null,
    rows: shown.slice(1),
    note,
    glim: { guests: extras.glimPaddleIds.length, bids: extras.glimBids, withinLimits: extras.glimWithinLimits },
  };
}
