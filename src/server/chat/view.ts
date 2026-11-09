/**
 * The panel's whole picture of one guest's chat: what it opens with, its status line, every message
 * with its card, and the quick replies that fit right now. Built fresh from the database each time, so
 * a card's "Winning at $320" and the header's hold always read live.
 */
import { z } from "zod";

import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { eventHasEnded } from "@/server/engine/rules";
import type { EventStatus } from "@/server/engine/types";
import { planItemStatusText } from "@/server/glim/cards";
import { greeting, NO_HOLD_LINE } from "@/server/glim/copy";
import { formatUsd } from "@/server/glim/money";
import { isOpenForBids, timeFormatter } from "@/server/glim/prompt";
import type { GlimState } from "@/server/glim/types";
import { planCardSchema } from "@/server/plans/proposals";
import { loadGlimState } from "@/server/queries/glim-state";

import { frozenNow } from "./frozen-clock";
import type {
  ChatCardView,
  ChatMessageView,
  ChatView,
  HoldCardView,
  PlanCardItemView,
  PlanCardState,
  PlanCardView,
  QuickReply,
} from "./types";

export interface ChatViewer {
  paddleId: string;
  paddleNumber: number;
  firstName: string;
  eventId: string;
  eventSlug: string;
}

export const HOW_AM_I_DOING = "How am I doing?";
/** The approved chip's wording for the lot the mockup shows; any other lot is "Skip <short title>". */
const APPROVED_SKIP_LABELS: Readonly<Record<string, string>> = { "Spa Day": "Skip the spa" };
/** 07 names this lot more briefly than its full title; every other lot shows its title. */
const APPROVED_CARD_TITLES: Readonly<Record<string, string>> = { "Chef’s Table Dinner for Four": "Chef’s Table Dinner" };

/** 09, with an amount preselected when Glim suggested one. It opens in raise mode for a guest with a hold. */
export function biddingPowerHref(slug: string, amountCents: number | null = null): string {
  const path = `/e/${encodeURIComponent(slug)}/power`;
  return amountCents === null ? path : `${path}?amount=${Math.round(amountCents / 100)}`;
}

function skipLabel(shortTitle: string): string {
  return APPROVED_SKIP_LABELS[shortTitle] ?? `Skip ${shortTitle}`;
}

/** What the row above the input offers now: 07's three in the state it draws, and the nearest fit in the others. */
export function chatQuickReplies(input: { state: GlimState; eventLive: boolean; slug: string }): QuickReply[] {
  const { state, eventLive, slug } = input;
  const ask: QuickReply = { kind: "ask", label: HOW_AM_I_DOING, text: HOW_AM_I_DOING };
  if (!eventLive) return [ask];
  if (state.holdCents === null) return [{ kind: "link", label: "Set your bidding power", href: biddingPowerHref(slug) }];
  const replies: QuickReply[] = [];
  if (state.plan?.status === "paused") replies.push({ kind: "resume", label: "Resume Glim" });
  if (state.holdCents < state.event.holdMaxCents) {
    replies.push({ kind: "link", label: "Raise my budget", href: biddingPowerHref(slug) });
  }
  if (state.plan?.status === "active") {
    const lots = new Map(state.lots.map((lot) => [lot.number, lot]));
    const last = [...state.plan.items]
      .filter((item) => {
        const lot = lots.get(item.lotNumber);
        return item.status !== "skipped" && lot !== undefined && isOpenForBids(lot, state.now);
      })
      .sort((a, b) => b.priority - a.priority || b.lotNumber - a.lotNumber)[0];
    const lot = last ? lots.get(last.lotNumber) : undefined;
    if (lot) replies.push({ kind: "skip", label: skipLabel(lot.shortTitle), lotNumber: lot.number });
  }
  return [...replies, ask];
}

export function chatStatus(input: {
  state: GlimState;
  eventStatus: EventStatus;
  closedAt: Date | null;
  closesAt: Date;
}): ChatView["status"] {
  const { state, eventStatus } = input;
  const clock = timeFormatter(state.event.timezone, false);
  if (eventStatus !== "live") {
    const ended = eventHasEnded(eventStatus);
    return { tone: "off", text: ended ? `Off duty since ${clock(input.closedAt ?? input.closesAt)}` : "Off duty" };
  }
  if (state.holdCents === null) return { tone: "off", text: "Bidding power not set" };
  const held = `${formatUsd(state.holdCents)} held with PayPal`;
  return state.plan?.status === "paused" ? { tone: "off", text: `Paused · ${held}` } : { tone: "on", text: `On duty · ${held}` };
}

type MessageRow = { id: string; role: "guest" | "glim"; text: string; card_type: string; card: unknown; plan_id: string | null };
type PlanRow = { id: string; status: string; confirmed_at: Date | null; paused_at: Date | null; ended_at: Date | null };

const holdCardSchema = z.object({
  type: z.literal("hold"),
  amountCents: z.number().int(),
  currentHoldCents: z.number().int().nullable(),
});

const eventCardSchema = z.object({
  type: z.literal("event"),
  actionId: z.string().nullable(),
  at: z.string(),
  eyebrow: z.string(),
  line: z.string(),
  chip: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("winning"), amountCents: z.number().int() }),
    z.object({ kind: z.literal("closed") }),
  ]).nullable(),
});

/** Glim's offer, until the bidding ends or the bidding power reaches it; the words stay in the chat either way. */
function holdCardView(card: z.infer<typeof holdCardSchema>, { state, eventLive, slug }: CardContext): HoldCardView | null {
  if (!eventLive || (state.holdCents !== null && card.amountCents <= state.holdCents)) return null;
  const raising = state.holdCents !== null;
  return {
    type: "hold",
    amountCents: card.amountCents,
    currentHoldCents: state.holdCents,
    // 10's and 09's approved words for the same two steps.
    label: raising ? "Raise bidding power" : "Set your bidding power",
    note: raising ? "Approve another hold in a PayPal window" : "You’ll approve the hold in a PayPal window, then come back to bid.",
    href: biddingPowerHref(slug, card.amountCents),
  };
}

interface CardContext {
  state: GlimState;
  eventLive: boolean;
  slug: string;
  plans: ReadonlyMap<string, PlanRow>;
  titles: ReadonlyMap<string, string>;
}

/** The line under a plan lot, as things stand now: 07's approved wording while it is open. */
function liveStatusText(lotNumber: number, { state }: CardContext): string {
  const lot = state.lots.find((candidate) => candidate.number === lotNumber);
  if (!lot) return "Closed";
  if (lot.guestStatus === "won" && lot.currentBidCents !== null) return `Won at ${formatUsd(lot.currentBidCents)}`;
  return lot.status === "closed" ? "Closed" : planItemStatusText(lot);
}

function planCardState(plan: PlanRow | undefined, eventLive: boolean): { state: PlanCardState; line: (clock: (at: Date) => string) => string | null } {
  switch (plan?.status) {
    case "proposed":
      return { state: eventLive ? "proposed" : "over", line: () => null };
    case "active":
      return {
        state: eventLive ? "running" : "over",
        line: (clock) => (plan.confirmed_at ? `Started at ${clock(plan.confirmed_at)}` : null),
      };
    case "paused":
      return {
        state: eventLive ? "paused" : "over",
        line: (clock) => (plan.paused_at ? `Paused since ${clock(plan.paused_at)}` : "Paused"),
      };
    case "superseded":
      return { state: "over", line: (clock) => (plan.ended_at ? `Replaced at ${clock(plan.ended_at)}` : "Replaced") };
    default:
      return { state: "over", line: () => null };
  }
}

function planCardView(row: MessageRow, context: CardContext): PlanCardView | null {
  const parsed = planCardSchema.safeParse(row.card);
  if (!parsed.success || !row.plan_id) return null;
  const card = parsed.data;
  const { state, line } = planCardState(context.plans.get(row.plan_id), context.eventLive);
  const items: PlanCardItemView[] = card.items.map((item) => {
    const title = context.titles.get(item.lotId) ?? item.shortTitle;
    return {
      lotId: item.lotId,
      lotNumber: item.lotNumber,
      title: APPROVED_CARD_TITLES[title] ?? title,
      priority: item.priority,
      maxCents: item.maxCents,
      statusText: liveStatusText(item.lotNumber, context),
      sharePercent: card.budgetCents > 0 ? (item.maxCents / card.budgetCents) * 100 : 0,
    };
  });
  return {
    type: "plan",
    planId: row.plan_id,
    state,
    stateLine: line(timeFormatter(context.state.event.timezone, false)),
    budgetCents: card.budgetCents,
    items,
    autopilot: card.autopilot,
  };
}

function cardView(row: MessageRow, context: CardContext): ChatCardView | null {
  if (row.card === null) return null;
  if (row.card_type === "plan") return planCardView(row, context);
  const type = (row.card as { type?: unknown }).type;
  if (type === "event") {
    const parsed = eventCardSchema.safeParse(row.card);
    return parsed.success ? parsed.data : null;
  }
  if (type === "hold") {
    const parsed = holdCardSchema.safeParse(row.card);
    return parsed.success ? holdCardView(parsed.data, context) : null;
  }
  // Stored by the autopilot; the panel draws them once design/21 is approved (src/ui/glim/AutopilotCards.tsx).
  if (type === "autopilot" || type === "autopilot_raise") return row.card as ChatCardView;
  return null;
}

export async function loadChatView(viewer: ChatViewer, database: DatabaseClient = getDatabaseClient()): Promise<ChatView> {
  const { pool } = database;
  const [state, event, messages, plans, titles] = await Promise.all([
    loadGlimState({ paddleId: viewer.paddleId, now: frozenNow(viewer.eventSlug) }, database),
    pool.query<{ status: EventStatus; closes_at: Date; closed_at: Date | null }>(
      "select status, closes_at, closed_at from events where id = $1",
      [viewer.eventId],
    ),
    pool.query<MessageRow>(
      `select id, role, text, card_type, card, plan_id from chat_messages
       where paddle_id = $1 order by created_at, id`,
      [viewer.paddleId],
    ),
    pool.query<PlanRow>("select id, status, confirmed_at, paused_at, ended_at from glim_plans where paddle_id = $1", [viewer.paddleId]),
    pool.query<{ id: string; title: string }>("select id, title from lots where event_id = $1", [viewer.eventId]),
  ]);
  const eventRow = event.rows[0];
  if (!state || !eventRow) throw new Error(`No paddle ${viewer.paddleId} in event ${viewer.eventId}`);

  const eventLive = eventRow.status === "live";
  const context: CardContext = {
    state,
    eventLive,
    slug: viewer.eventSlug,
    plans: new Map(plans.rows.map((row) => [row.id, row])),
    titles: new Map(titles.rows.map((row) => [row.id, row.title])),
  };
  return {
    firstName: viewer.firstName,
    paddleNumber: viewer.paddleNumber,
    greeting: state.holdCents === null ? `Hi ${viewer.firstName}. ${NO_HOLD_LINE}` : greeting(viewer.firstName),
    status: chatStatus({ state, eventStatus: eventRow.status, closedAt: eventRow.closed_at, closesAt: eventRow.closes_at }),
    messages: messages.rows.map(
      (row): ChatMessageView => ({ id: row.id, role: row.role, text: row.text, card: cardView(row, context) }),
    ),
    quickReplies: chatQuickReplies({ state, eventLive, slug: viewer.eventSlug }),
  };
}

/** Whether the guest has ever written to Glim: the corner's invitation is only for those who haven't. */
export async function hasTalkedToGlim(paddleId: string, database: DatabaseClient = getDatabaseClient()): Promise<boolean> {
  const { rows } = await database.pool.query<{ talked: boolean }>(
    "select exists (select 1 from chat_messages where paddle_id = $1 and role = 'guest') as talked",
    [paddleId],
  );
  return rows[0]?.talked === true;
}
