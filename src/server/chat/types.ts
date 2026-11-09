/**
 * What the Glim panel reads, shared by the server and the browser. Only `import type` from other
 * modules, so a client component can import this file.
 *
 * POST /api/glim/[slug]/messages answers NDJSON: one ChatStreamFrame per line. Text frames build the
 * reply as it streams, a reset discards what came so far (a retry or a code-written replacement
 * follows), and done carries the panel's whole new view.
 */
import type { AutopilotCard, AutopilotRaiseCard, PlanCardAutopilotLines } from "@/server/glim/autopilot/copy";

/** design/22 #20: a won lot keeps 11's won symbol on a lime chip; a lost one gets 10's grey "Closed". */
export type EventCardChip = { kind: "winning"; amountCents: number } | { kind: "won"; amountCents: number } | { kind: "closed" };

/** A deterministic line about something that happened: 07's event card. */
export interface EventCard {
  type: "event";
  actionId: string | null;
  /** ISO instant of the fact behind the card. */
  at: string;
  /** "9:14 PM · CHEF’S TABLE". */
  eyebrow: string;
  line: string;
  chip: EventCardChip | null;
}

export interface PlanCardItemView {
  lotId: string;
  lotNumber: number;
  title: string;
  priority: number;
  maxCents: number;
  /** On a change card, the running plan's maximum for this lot when it differs: "WAS $380". */
  wasCents: number | null;
  /** "Winning at $320", read live each time the view is built. */
  statusText: string;
  /** The item's width in the allocation bar, as a percentage of the budget. */
  sharePercent: number;
}

/** proposed: waits for Start bidding. running and paused: the guest's plan now. over: replaced or finished. */
export type PlanCardState = "proposed" | "running" | "paused" | "over";

/** One lot in the plan editor (design/22 #7, #8): its maximum opens as a field. */
export interface PlanEditItemView {
  lotNumber: number;
  title: string;
  priority: number;
  maxCents: number;
  /** The lowest maximum the lot takes: its next bid, or the guest's own bid where they lead. */
  minCents: number;
  /** Which of the two minCents is, for "That’s its next bid." */
  minIsOwnBid: boolean;
  /** What stays committed on this lot if it leaves the plan (bids placed stand). */
  withoutPlanCents: number;
  statusText: string;
}

/** What the editor starts from, and what it checks a plan against before Done. */
export interface PlanEditView {
  planId: string;
  /** The bidding power: the hold. */
  holdCents: number;
  /** Committed on lots the editor doesn't list; the plan can use the rest of the hold. */
  outsideCents: number;
  items: PlanEditItemView[];
}

export interface PlanCardView {
  type: "plan";
  planId: string;
  state: PlanCardState;
  /** "My plan for you", or "My new plan for you" on a change to a running plan (design/22 #9). */
  eyebrow: string;
  /** The consent button: "Start bidding", "Update plan", or "Update and resume" while paused. */
  startLabel: string;
  /** The quiet label where Start bidding was: "Started at 9:11 PM", "Replaced at 9:16 PM"; null on a card that waits. */
  stateLine: string | null;
  budgetCents: number;
  items: PlanCardItemView[];
  /** True when the card arms the autopilot. */
  autopilot: boolean;
  /** The "ON MY OWN" block (V1, design/21), when autopilot is on for this card. */
  onMyOwn: PlanCardAutopilotLines | null;
  /** The plan editor, on the card that waits and on the running plan's card; null where Edit doesn't show. */
  edit: PlanEditView | null;
}

/** Glim's raise offer (suggest_hold_amount, design/22 #5): a button to 09, with the amount preselected. */
export interface HoldCardView {
  type: "hold";
  amountCents: number;
  currentHoldCents: number | null;
  /** "CABIN STAY · CURRENT BID" and "$640": the lot the raise is for, when it names one. */
  lot: { label: string; amountCents: number } | null;
  /** "You have $180 left of $500."; null with no bidding power yet. */
  left: { leftCents: number; holdCents: number } | null;
  label: string;
  note: string;
  href: string;
}

/** design/22 #2: no bidding power yet, so Glim sends the guest to 09. */
export interface SetPowerCardView {
  type: "set_power";
  label: string;
  note: string;
  href: string;
}

/** design/22 #12: Glim's last card once bidding closes, with the receipt when the guest won. */
export interface ClosingCardView {
  type: "closing";
  eyebrow: string;
  line: string;
  receipt: { label: string; href: string } | null;
}

/** V2 as the panel shows it: Skip only while Glim still bids on the lot it added. */
export type AutopilotCardView = AutopilotCard & { skipLotNumber: number | null };

/** V3 as the panel shows it: ended once the offer can no longer be taken (design/21 #10). */
export type AutopilotRaiseCardView = AutopilotRaiseCard & { ended: boolean };

export type ChatCardView =
  | PlanCardView
  | EventCard
  | HoldCardView
  | SetPowerCardView
  | ClosingCardView
  | AutopilotCardView
  | AutopilotRaiseCardView;

export interface ChatMessageView {
  id: string;
  role: "guest" | "glim";
  text: string;
  card: ChatCardView | null;
}

export type QuickReply =
  /** Goes to a page: 09, to set or raise bidding power. */
  | { kind: "link"; label: string; href: string }
  /** Sends `text` to Glim as the guest's message. */
  | { kind: "ask"; label: string; text: string }
  /** Ends Glim's limit on this lot at once; bids stand. */
  | { kind: "skip"; label: string; lotNumber: number }
  | { kind: "resume"; label: string };

/**
 * The header's status (design/22 #23): a lime dot while Glim can bid, a grey one when it can't, the
 * pause mark while paused, and 09's spinner while the autopilot decides (design/21 #4).
 */
export type ChatStatusMark = "on" | "off" | "paused" | "deciding";

export interface ChatView {
  firstName: string;
  paddleNumber: number;
  /** The line the panel opens with, before the guest's first message. */
  greeting: string;
  /** The card under the greeting: "Set bidding power" while there is no hold (design/22 #2). */
  greetingCard: SetPowerCardView | null;
  status: { tone: "on" | "off"; mark: ChatStatusMark; text: string };
  /** The header's own button beside Minimize: pause bars while a plan runs, Resume while paused. */
  planControl: "pause" | "resume" | null;
  messages: ChatMessageView[];
  /** After bidding closes: Glim's last card, below every message. */
  closing: ClosingCardView | null;
  quickReplies: QuickReply[];
  /** Set once bidding has closed: the input keeps its shape, shows this and takes no message. */
  inputClosed: string | null;
}

export type ChatStreamFrame =
  | { type: "text"; text: string }
  | { type: "reset" }
  | {
      type: "done";
      view: ChatView;
      /** A reply that was not stored (the caps, an empty message): the panel shows it for now. */
      unsaved: { guestText: string; reply: string } | null;
    }
  | { type: "error"; code: string; message: string };
