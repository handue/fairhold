/**
 * What the Glim panel reads, shared by the server and the browser. Only `import type` from other
 * modules, so a client component can import this file.
 *
 * POST /api/glim/[slug]/messages answers NDJSON: one ChatStreamFrame per line. Text frames build the
 * reply as it streams, a reset discards what came so far (a retry or a code-written replacement
 * follows), and done carries the panel's whole new view.
 */
import type { AutopilotCard, AutopilotRaiseCard } from "@/server/glim/autopilot/copy";

export type EventCardChip = { kind: "winning"; amountCents: number } | { kind: "closed" };

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
  /** "Winning at $320", read live each time the view is built. */
  statusText: string;
  /** The item's width in the allocation bar, as a percentage of the budget. */
  sharePercent: number;
}

/** proposed: waits for Start bidding. running and paused: the guest's plan now. over: replaced or finished. */
export type PlanCardState = "proposed" | "running" | "paused" | "over";

export interface PlanCardView {
  type: "plan";
  planId: string;
  state: PlanCardState;
  /** Plain text where the buttons were: "Started at 9:11 PM"; null on a card that waits. */
  stateLine: string | null;
  budgetCents: number;
  items: PlanCardItemView[];
  /** True when the card would arm the autopilot; its "ON MY OWN" block waits for design/21. */
  autopilot: boolean;
}

/** Glim's raise offer (suggest_hold_amount): a button to 09, with the amount preselected. */
export interface HoldCardView {
  type: "hold";
  amountCents: number;
  currentHoldCents: number | null;
  label: string;
  note: string;
  href: string;
}

export type ChatCardView = PlanCardView | EventCard | HoldCardView | AutopilotCard | AutopilotRaiseCard;

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

export interface ChatView {
  firstName: string;
  paddleNumber: number;
  /** The line the panel opens with, before the guest's first message. */
  greeting: string;
  status: { tone: "on" | "off"; text: string };
  messages: ChatMessageView[];
  quickReplies: QuickReply[];
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
