/**
 * What /api/stream sends, shared by the server and the browser. Only `import type` from other modules,
 * so a client component can import this file.
 *
 * Wire format: every event_log row is one SSE frame, and its event name is the row's type:
 *
 *   id: 4817
 *   event: bid
 *   data: {"id":"4817","type":"bid","paddleId":null,"at":1794200000000,"payload":{"kind":"bids_placed",...}}
 *
 * Control frames (STREAM_CONTROL_EVENTS) have no id, so they never move Last-Event-ID.
 *
 * Who receives what: canSeeStreamRow below, which the stream's replay query must match. Every frame
 * of a row is `StreamEvent`; narrow on `type`, then on `payload.kind` (hold rows: `payload.status`).
 * New payloads go here first, so the writer and the browser agree on them.
 */
import type {
  BidsPlacedPayload,
  EventClosedPayload,
  LimitBlockedPayload,
  LimitExhaustedPayload,
  LimitRaisedPayload,
  LimitRemovedPayload,
  LimitSetPayload,
  LimitsPausedPayload,
  LotClosedPayload,
  LotLostPayload,
  LotWonPayload,
  OutbidPayload,
} from "@/server/engine/events";
import type { AutopilotOutcome } from "@/server/glim/autopilot/types";
import type { HoldRefusal, HoldStatus } from "@/server/paypal/hold-store";

/** The event_log.type enum; tests/unit/db/schema-contract.test.ts checks it against the schema. */
export const EVENT_LOG_TYPES = ["bid", "lot_closed", "event_status", "hold", "glim", "settlement"] as const;
export type EventLogType = (typeof EVENT_LOG_TYPES)[number];

/** A proxy limit's facts: type "glim" when Glim owns the limit, "bid" for a guest's own max. */
export type LimitFactPayload =
  | LimitSetPayload
  | LimitRaisedPayload
  | LimitExhaustedPayload
  | LimitBlockedPayload
  | LimitRemovedPayload
  | LimitsPausedPayload;

/** Paddle: the guest hearted a lot or took the heart away, so their other tabs follow. */
export type FavoriteChangedPayload = {
  kind: "favorite_changed";
  lotId: string;
  lotNumber: number;
  isFavorite: boolean;
};

// event_status -----------------------------------------------------------------------------------

/** Public: charging started, or it finished for every paddle. */
export type EventSettlementStatusPayload = { kind: "event_settling"; status: "settling" } | { kind: "event_settled"; status: "settled" };

/** Public: the demo controls moved close times ("Close next lot", "Add 10 minutes"). Instants are epoch ms. */
export type ScheduleChangedPayload = {
  kind: "schedule_changed";
  /** The event's close, when it moved. */
  closesAt: number | null;
  /** The lots that moved. */
  lots: { lotId: string; lotNumber: number; closesAt: number }[];
};

// hold -------------------------------------------------------------------------------------------

/** Paddle (and organizer): one hold changed status. It has no `kind`; narrow on `status`. */
export type HoldStreamPayload = {
  holdId: string;
  status: HoldStatus;
  /** On authorized, and on a refused approval: what PayPal authorized. */
  amountCents?: number;
  /** On replaced: the hold in place now (none when a refused approval had nothing to defer to). */
  replacedByHoldId?: string | null;
  /** On denied or failed: PayPal's issue code. */
  code?: string | null;
  /** On a refused approval (status replaced): why it did not become the bidding power. */
  reason?: HoldRefusal["reason"];
  currentHoldCents?: number;
  committedCents?: number;
};

// glim -------------------------------------------------------------------------------------------

/** Paddle: a model call started; 07's header reads "Deciding…" until autopilot_finished. */
export type AutopilotDecidingPayload = { kind: "autopilot_deciding"; runId: string };

/** Paddle: a run ended. When it wrote a card, chatMessageId names the chat_messages row to render. */
export type AutopilotFinishedPayload = {
  kind: "autopilot_finished";
  runId: string;
  outcome: AutopilotOutcome;
  chatMessageId: string | null;
  actionId?: string;
  lotIds?: string[];
  /** The limits this run created: their limit_set and opening limit_raised rows get no card of their own. */
  limitIds?: string[];
};

/** Paddle: a new chat_messages row exists (an event card from an engine fact); render it by id. */
export type ChatCardPayload = { kind: "chat_card"; chatMessageId: string; actionId: string | null };

/** Paddle: the plan changed state, which 07's header and 10's Pause and Resume follow. */
export type PlanStatusPayload = {
  kind: "plan_status";
  planId: string;
  status: "active" | "paused" | "ended" | "superseded";
  version: number;
};

// settlement -------------------------------------------------------------------------------------

/** Public: the totals of a settlement that just started; nothing about any one paddle. */
export type SettlementStartedPayload = {
  kind: "settlement_started";
  settlementId: string;
  winners: number;
  nonWinners: number;
  toChargeCents: number;
  toReleaseCents: number;
};

/** Paddle (and organizer): one paddle's capture, void or simulated settlement moved on. */
export type SettlementItemPayload = {
  kind: "settlement_item";
  settlementId: string;
  itemId: string;
  paddleNumber: number;
  action: "capture" | "void" | "simulate";
  status: "queued" | "processing" | "succeeded" | "pending" | "failed";
  amountCents: number;
  releasedCents: number;
  /** The receipt's transaction ID, on a succeeded capture. */
  paypalCaptureId: string | null;
  errorCode: string | null;
};

/** Public: every item reached an end state. */
export type SettlementFinishedPayload = {
  kind: "settlement_finished";
  settlementId: string;
  status: "done" | "done_with_errors";
};

// ------------------------------------------------------------------------------------------------

/** The payload of each row type. Public rows have paddleId null; the rest go to that paddle. */
export interface StreamPayloads {
  bid: BidsPlacedPayload | OutbidPayload | LimitFactPayload | FavoriteChangedPayload;
  lot_closed: LotClosedPayload | LotWonPayload | LotLostPayload;
  event_status: EventClosedPayload | EventSettlementStatusPayload | ScheduleChangedPayload;
  hold: HoldStreamPayload;
  glim: LimitFactPayload | AutopilotDecidingPayload | AutopilotFinishedPayload | ChatCardPayload | PlanStatusPayload;
  settlement: SettlementStartedPayload | SettlementItemPayload | SettlementFinishedPayload;
}

/** The data of a row's frame. */
export type StreamEventOf<Type extends EventLogType> = {
  /** event_log.id as a decimal string: the frame's SSE id, and where a reconnect resumes. */
  id: string;
  type: Type;
  /** The channel: null is the event's public one, otherwise that paddle's. */
  paddleId: string | null;
  /** event_log.created_at in epoch ms. */
  at: number;
  payload: StreamPayloads[Type];
};

export type StreamEvent = { [Type in EventLogType]: StreamEventOf<Type> }[EventLogType];

/** Frames that are not event_log rows. */
export const STREAM_CONTROL_EVENTS = ["hello", "heartbeat", "resync"] as const;
export type StreamControlEvent = (typeof STREAM_CONTROL_EVENTS)[number];

export interface StreamControlPayloads {
  /** First frame of every connection. serverNow is epoch ms, for the clock offset. */
  hello: {
    serverNow: number;
    paddleId: string | null;
    paddleNumber: number | null;
    isOrganizer: boolean;
    /** Every row this viewer may see after this position follows on this connection. */
    after: string;
    /** The newest row when the connection opened: rows up to here are replay, not news. */
    latest: string;
  };
  /** Every STREAM_HEARTBEAT_SECONDS. A client that hears nothing for two beats reconnects. */
  heartbeat: { serverNow: number };
  /**
   * The client missed more than the replay limit: refetch the page's data, then carry on. The stream
   * goes on from `position`; rows at or before it were skipped.
   */
  resync: { reason: "too_far_behind"; position: string };
}

export const STREAM_HEARTBEAT_SECONDS = 15;
/** Most rows one reconnect replays; past it the stream sends `resync`. */
export const STREAM_REPLAY_LIMIT = 1_000;
/** After this many failed reconnects in a row, the client falls back to polling. */
export const STREAM_POLL_AFTER_FAILURES = 5;
export const STREAM_POLL_SECONDS = 5;
/**
 * Rows of the event a connection with no position starts behind. A page reads its data, then takes
 * a moment to hydrate and connect; these cover that gap, so a fresh connection never skips a row
 * the page has not seen.
 */
export const STREAM_RECENT_ROWS = 100;

/** What GET /api/stream/poll answers: the same rows as the stream, for a client that cannot hold one open. */
export interface StreamPollResponse {
  serverNow: number;
  /** As hello's: every row this viewer may see after this position is in `rows`, unless `resync`. */
  after: string;
  /** Pass it as `after` next time. */
  position: string;
  rows: StreamEvent[];
  /** Too far behind, as the stream's resync: `rows` is empty and the page's data should be refetched. */
  resync: boolean;
}

/** Every SSE event name a client can receive. */
export const STREAM_EVENT_NAMES = [...EVENT_LOG_TYPES, ...STREAM_CONTROL_EVENTS] as const;

/**
 * What an organizer also receives from every paddle's channel, for 12's live ledger: holds and
 * settlement items. Never Glim's activity, nor a paddle's bid news.
 */
export const ORGANIZER_STREAM_TYPES: readonly EventLogType[] = ["hold", "settlement"];

export interface StreamViewer {
  paddleId: string | null;
  isOrganizer: boolean;
}

/** The largest bigint: Postgres refuses to compare event_log.id with anything past it. */
const MAX_STREAM_POSITION = "9223372036854775807";

/** A stream position from a header or a URL, normalized; null when it is not one. */
export function parseStreamPosition(value: string | null | undefined): string | null {
  if (!value || !/^\d{1,19}$/.test(value)) return null;
  const position = value.replace(/^0+(?=\d)/, "");
  return isAfterPosition(position, MAX_STREAM_POSITION) ? null : position;
}

/** Whether position `a` comes after `b`. Positions are bigints as decimal strings, with no leading zeros. */
export function isAfterPosition(a: string, b: string): boolean {
  return a.length === b.length ? a > b : a.length > b.length;
}

/** Whether a row goes to a viewer of the row's event. */
export function canSeeStreamRow(row: { type: EventLogType; paddleId: string | null }, viewer: StreamViewer): boolean {
  if (row.paddleId === null || row.paddleId === viewer.paddleId) return true;
  return viewer.isOrganizer && ORGANIZER_STREAM_TYPES.includes(row.type);
}
