/**
 * The panel's whole picture of one guest's chat: what it opens with, its status line, every message
 * with its card, and the quick replies that fit right now. Built fresh from the database each time, so
 * a card's "Winning at $320" and the header's hold always read live. Every state follows design/21
 * (Glim autopilot), design/21b and design/22 (Glim chat states), all approved Nov 9.
 */
import { z } from "zod";

import { getDatabaseClient, type DatabaseClient } from "@/server/db/client";
import { eventHasEnded } from "@/server/engine/rules";
import type { EventStatus } from "@/server/engine/types";
import { minimumMaxCents } from "@/server/glim/allocator";
import { planCardAutopilotLines, type AutopilotCard, type AutopilotRaiseCard } from "@/server/glim/autopilot/copy";
import { planItemStatusText, type PlanCard } from "@/server/glim/cards";
import {
  amountGuardLine,
  BIDDING_CLOSED_INPUT,
  biddingClosedLine,
  greeting,
  HOLD_NOT_CHARGE_NOTE,
  NO_HOLD_LINE,
  RAISE_WINDOW_NOTE,
} from "@/server/glim/copy";
import { parseMandate } from "@/server/glim/mandate";
import { formatUsd } from "@/server/glim/money";
import { biddingPowerFigures, isOpenForBids, timeFormatter } from "@/server/glim/prompt";
import type { GlimState } from "@/server/glim/types";
import { readBiddingHold } from "@/server/holds/bidding-hold";
import { planCardSchema } from "@/server/plans/proposals";
import { loadOpenRaiseOffer, type OpenRaiseOffer } from "@/server/plans/raise-offer";
import { loadGlimState } from "@/server/queries/glim-state";

import { eventEyebrow } from "./event-cards";
import { frozenNow } from "./frozen-clock";
import type {
  AutopilotCardView,
  AutopilotRaiseCardView,
  ChatCardView,
  ChatMessageView,
  ChatView,
  ClosingCardView,
  HoldCardView,
  PlanCardItemView,
  PlanCardState,
  PlanCardView,
  PlanEditView,
  QuickReply,
  SetPowerCardView,
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
/** A Deciding… row this old with no finished row is a run that died; the lease takes it from there. */
const DECIDING_STALE_SECONDS = 30;

/** 09, with an amount preselected when Glim suggested one. It opens in raise mode for a guest with a hold. */
export function biddingPowerHref(slug: string, amountCents: number | null = null): string {
  const path = `/e/${encodeURIComponent(slug)}/power`;
  return amountCents === null ? path : `${path}?amount=${Math.round(amountCents / 100)}`;
}

function skipLabel(shortTitle: string): string {
  return APPROVED_SKIP_LABELS[shortTitle] ?? `Skip ${shortTitle}`;
}

const ask = (label: string, text: string = label): QuickReply => ({ kind: "ask", label, text });

/** What the last exchange was, for the quick replies that follow it. */
export interface LastExchange {
  /** The guest has written to Glim. */
  talked: boolean;
  /** Glim's last reply was the error fallback (design/22 #4); this is what the guest had asked. */
  failedGuestText: string | null;
  /** Glim's last reply turned a proposal down (design/22 #5, #6). */
  refused: boolean;
}

const NO_EXCHANGE: LastExchange = { talked: false, failedGuestText: null, refused: false };

/**
 * What the row above the input offers now (design/22): the first open's three, "Try again" after an
 * error, "What else fits?" after a refusal or once the guest has talked with no plan running, and
 * 07's three while a plan runs or is paused. Nothing once bidding is over: the input closes.
 */
export function chatQuickReplies(input: {
  state: GlimState;
  eventLive: boolean;
  slug: string;
  last?: LastExchange;
  /** The lots the guest planned themselves; Skip offers one of these, not a backup Glim moved to (21b). */
  guestPlanLots?: ReadonlySet<number>;
}): QuickReply[] {
  const { state, eventLive, slug } = input;
  const last = input.last ?? NO_EXCHANGE;
  if (!eventLive) return [];
  if (state.holdCents === null) return [ask("How does a hold work?"), ask("What can you do?")];
  if (last.failedGuestText !== null) {
    return [ask("Try again", last.failedGuestText), { kind: "link", label: "See the lots", href: `/e/${encodeURIComponent(slug)}` }];
  }
  const running = state.plan?.status === "active" || state.plan?.status === "paused";
  if (running && !last.refused) {
    const replies: QuickReply[] = [];
    if (state.holdCents < state.event.holdMaxCents) {
      replies.push({ kind: "link", label: "Raise my budget", href: biddingPowerHref(slug) });
    }
    const lots = new Map(state.lots.map((lot) => [lot.number, lot]));
    const lastLot = [...(state.plan?.items ?? [])]
      .filter((item) => {
        const lot = lots.get(item.lotNumber);
        const planned = input.guestPlanLots === undefined || input.guestPlanLots.has(item.lotNumber);
        return planned && item.status !== "skipped" && lot !== undefined && isOpenForBids(lot, state.now);
      })
      .sort((a, b) => b.priority - a.priority || b.lotNumber - a.lotNumber)[0];
    const lot = lastLot ? lots.get(lastLot.lotNumber) : undefined;
    if (lot) replies.push({ kind: "skip", label: skipLabel(lot.shortTitle), lotNumber: lot.number });
    return [...replies, ask(HOW_AM_I_DOING)];
  }
  if (last.talked || last.refused) return [ask("What else fits?"), ask(HOW_AM_I_DOING)];
  return [ask(`All ${formatUsd(state.holdCents)}`), ask("What closes next?"), ask("What can you do?")];
}

/**
 * The header's status (design/22 #23): "Not bidding yet" until Start bidding, "On duty" while a plan
 * runs ("Deciding…" while the autopilot decides, design/21 #4), "Paused since 9:15 PM", and 11's
 * "Off duty since 9:30 PM" once bidding closes.
 */
export function chatStatus(input: {
  state: GlimState;
  eventStatus: EventStatus;
  closedAt: Date | null;
  closesAt: Date;
  pausedAt?: Date | null;
  deciding?: boolean;
}): ChatView["status"] {
  const { state, eventStatus } = input;
  const clock = timeFormatter(state.event.timezone, false);
  if (eventStatus !== "live") {
    const ended = eventHasEnded(eventStatus);
    return { tone: "off", mark: "off", text: ended ? `Off duty since ${clock(input.closedAt ?? input.closesAt)}` : "Off duty" };
  }
  if (state.holdCents === null) return { tone: "off", mark: "off", text: "Bidding power not set" };
  const held = `${formatUsd(state.holdCents)} held with PayPal`;
  if (state.plan?.status === "paused") {
    return { tone: "off", mark: "paused", text: input.pausedAt ? `Paused since ${clock(input.pausedAt)}` : "Paused" };
  }
  if (state.plan?.status === "active") {
    return input.deciding ? { tone: "on", mark: "deciding", text: "Deciding…" } : { tone: "on", mark: "on", text: `On duty · ${held}` };
  }
  return { tone: "off", mark: "off", text: `Not bidding yet · ${held}` };
}

type MessageRow = {
  id: string;
  role: "guest" | "glim";
  text: string;
  card_type: string;
  card: unknown;
  plan_id: string | null;
  error: string | null;
  refused: boolean;
};
type PlanRow = { id: string; status: string; confirmed_at: Date | null; paused_at: Date | null; ended_at: Date | null };

const holdCardSchema = z.object({
  type: z.literal("hold"),
  amountCents: z.number().int(),
  currentHoldCents: z.number().int().nullable(),
  lotNumbers: z.array(z.number().int()).default([]),
});

const eventCardSchema = z.object({
  type: z.literal("event"),
  actionId: z.string().nullable(),
  at: z.string(),
  eyebrow: z.string(),
  line: z.string(),
  chip: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("winning"), amountCents: z.number().int() }),
      z.object({ kind: z.literal("won"), amountCents: z.number().int() }),
      z.object({ kind: z.literal("closed") }),
    ])
    .nullable(),
});

interface CardContext {
  state: GlimState;
  eventLive: boolean;
  slug: string;
  plans: ReadonlyMap<string, PlanRow>;
  titles: ReadonlyMap<string, string>;
  /** The raise Glim prepared that the guest can still take. */
  openRaise: OpenRaiseOffer | null;
}

const lotByNumber = ({ state }: CardContext, lotNumber: number) => state.lots.find((candidate) => candidate.number === lotNumber);

/** design/22 #5: Glim's offer, until the bidding ends or the bidding power reaches it; the words stay either way. */
function holdCardView(card: z.infer<typeof holdCardSchema>, context: CardContext): HoldCardView | null {
  const { state, eventLive, slug } = context;
  if (!eventLive || (state.holdCents !== null && card.amountCents <= state.holdCents)) return null;
  const raising = state.holdCents !== null;
  const firstLot = card.lotNumbers[0];
  const lot = firstLot === undefined ? undefined : lotByNumber(context, firstLot);
  const figures = biddingPowerFigures(state);
  return {
    type: "hold",
    amountCents: card.amountCents,
    currentHoldCents: state.holdCents,
    lot: lot
      ? lot.currentBidCents === null
        ? { label: `${lot.shortTitle} · Opening bid`, amountCents: lot.nextMinimumCents }
        : { label: `${lot.shortTitle} · Current bid`, amountCents: lot.currentBidCents }
      : null,
    left: figures && state.holdCents !== null ? { leftCents: Math.max(0, figures.leftCents), holdCents: state.holdCents } : null,
    // 10's and 09's approved words for the same two steps; the raise note is design/22 #5's.
    label: raising ? "Raise bidding power" : "Set your bidding power",
    note: raising ? RAISE_WINDOW_NOTE : "You’ll approve the hold in a PayPal window, then come back to bid.",
    href: biddingPowerHref(slug, card.amountCents),
  };
}

/** design/22 #2: the way to 09 while there is no hold. */
function setPowerCard(slug: string): SetPowerCardView {
  return { type: "set_power", label: "Set bidding power", note: HOLD_NOT_CHARGE_NOTE, href: biddingPowerHref(slug) };
}

/** The line under a plan lot, as things stand now: 07's approved wording while it is open. */
function liveStatusText(lotNumber: number, context: CardContext): string {
  const lot = lotByNumber(context, lotNumber);
  if (!lot) return "Closed";
  if (lot.guestStatus === "won" && lot.currentBidCents !== null) return `Won at ${formatUsd(lot.currentBidCents)}`;
  return lot.status === "closed" ? "Closed" : planItemStatusText(lot);
}

/**
 * Where the card stands (design/22 #22): Start bidding becomes the quiet "Started at 9:11 PM", and a
 * card a newer one replaced reads "Replaced at 9:16 PM".
 */
function planCardState(plan: PlanRow | undefined, eventLive: boolean): { state: PlanCardState; line: (clock: (at: Date) => string) => string | null } {
  const started = (clock: (at: Date) => string) => (plan?.confirmed_at ? `Started at ${clock(plan.confirmed_at)}` : null);
  switch (plan?.status) {
    case "proposed":
      return { state: eventLive ? "proposed" : "over", line: () => null };
    case "active":
      return { state: eventLive ? "running" : "over", line: started };
    case "paused":
      return { state: eventLive ? "paused" : "over", line: started };
    case "superseded":
      return { state: "over", line: (clock) => (plan.ended_at ? `Replaced at ${clock(plan.ended_at)}` : "Replaced") };
    default:
      return { state: "over", line: started };
  }
}

function cardTitle(lotId: string, fallback: string, context: CardContext): string {
  const title = context.titles.get(lotId) ?? fallback;
  return APPROVED_CARD_TITLES[title] ?? title;
}

/** The plan editor's lots: the card's while it waits, the running plan's own once it runs. */
function planEditView(planId: string, items: readonly { lotNumber: number; lotId: string; shortTitle: string; priority: number; maxCents: number }[], context: CardContext): PlanEditView | null {
  const { state } = context;
  if (state.holdCents === null) return null;
  const open = items.flatMap((item) => {
    const lot = lotByNumber(context, item.lotNumber);
    return lot && isOpenForBids(lot, state.now) ? [{ item, lot }] : [];
  });
  if (open.length === 0) return null;
  const listed = new Set(open.map(({ lot }) => lot.number));
  const commitment = (lotNumber: number) => state.commitments.find((entry) => entry.lotNumber === lotNumber);
  return {
    planId,
    holdCents: state.holdCents,
    outsideCents: state.commitments
      .filter((entry) => !listed.has(entry.lotNumber))
      .reduce((sum, entry) => sum + entry.withoutGlimCents, 0),
    items: [...open]
      .sort((a, b) => a.item.priority - b.item.priority || a.lot.number - b.lot.number)
      .map(({ item, lot }) => ({
        lotNumber: lot.number,
        title: cardTitle(item.lotId, item.shortTitle, context),
        priority: item.priority,
        maxCents: item.maxCents,
        minCents: minimumMaxCents(lot),
        minIsOwnBid: lot.guestStatus === "winning" && lot.currentBidCents !== null,
        withoutPlanCents: commitment(lot.number)?.withoutGlimCents ?? 0,
        statusText: planItemStatusText(lot),
      })),
  };
}

function runningPlanItems(context: CardContext) {
  const plan = context.state.plan;
  if (!plan || (plan.status !== "active" && plan.status !== "paused")) return [];
  return plan.items
    .filter((item) => item.status !== "skipped")
    .flatMap((item) => {
      const lot = lotByNumber(context, item.lotNumber);
      return lot ? [{ lotNumber: lot.number, lotId: lot.id, shortTitle: lot.shortTitle, priority: item.priority, maxCents: item.maxCents }] : [];
    });
}

function planCardView(row: MessageRow, context: CardContext): PlanCardView | null {
  const parsed = planCardSchema.safeParse(row.card);
  if (!parsed.success || !row.plan_id) return null;
  const card = parsed.data;
  const planRow = context.plans.get(row.plan_id);
  const { state, line } = planCardState(planRow, context.eventLive);
  const running = [...context.plans.values()].find((plan) => plan.status === "active" || plan.status === "paused");
  const isChange = card.kind === "change" && running !== undefined && running.id !== row.plan_id;
  const was = new Map(isChange && state === "proposed" ? runningPlanItems(context).map((item) => [item.lotNumber, item.maxCents]) : []);
  const items: PlanCardItemView[] = card.items.map((item) => {
    const previous = was.get(item.lotNumber);
    return {
      lotId: item.lotId,
      lotNumber: item.lotNumber,
      title: cardTitle(item.lotId, item.shortTitle, context),
      priority: item.priority,
      maxCents: item.maxCents,
      wasCents: previous !== undefined && previous !== item.maxCents ? previous : null,
      statusText: liveStatusText(item.lotNumber, context),
      sharePercent: card.budgetCents > 0 ? (item.maxCents / card.budgetCents) * 100 : 0,
    };
  });
  // The block's backups read live, like the plan's own lots, "Won at $220" and "Closed" included.
  const withLiveBackups: PlanCard = {
    ...card,
    backups: card.backups.map((backup) =>
      lotByNumber(context, backup.lotNumber) ? { ...backup, statusText: liveStatusText(backup.lotNumber, context) } : backup,
    ),
  };
  let edit: PlanEditView | null = null;
  if (state === "proposed") edit = planEditView(row.plan_id, card.items, context);
  else if (state === "running" || state === "paused") edit = planEditView(row.plan_id, runningPlanItems(context), context);
  return {
    type: "plan",
    planId: row.plan_id,
    state,
    eyebrow: card.kind === "change" ? "My new plan for you" : "My plan for you",
    startLabel: !isChange ? "Start bidding" : running?.status === "paused" ? "Update and resume" : "Update plan",
    stateLine: line(timeFormatter(context.state.event.timezone, false)),
    budgetCents: card.budgetCents,
    items,
    autopilot: card.autopilot,
    onMyOwn: planCardAutopilotLines(withLiveBackups),
    edit,
  };
}

/** V2: Skip stays while Glim still bids on the lot it added, the plan runs and bidding is live. */
function autopilotCardView(card: AutopilotCard, context: CardContext): AutopilotCardView {
  const { state, eventLive } = context;
  const lot = card.skip ? state.lots.find((candidate) => candidate.id === card.skip?.lotId) : undefined;
  const item = lot ? state.plan?.items.find((entry) => entry.lotNumber === lot.number) : undefined;
  const running = state.plan?.status === "active" || state.plan?.status === "paused";
  const skippable = eventLive && running && lot !== undefined && isOpenForBids(lot, state.now) && item !== undefined && item.status !== "skipped";
  return { ...card, skipLotNumber: skippable && lot ? lot.number : null };
}

/** V3: the offer stands only while it is the open one (src/server/plans/raise-offer.ts). */
function raiseCardView(card: AutopilotRaiseCard, context: CardContext): AutopilotRaiseCardView {
  return { ...card, ended: context.openRaise?.actionId !== card.actionId };
}

/** Glim's lines that send a guest with no hold to 09 (design/22 #2: "a budget typed here gets the same answer"). */
function asksForBiddingPower(text: string): boolean {
  return text === NO_HOLD_LINE || text === amountGuardLine(null, null);
}

function cardView(row: MessageRow, context: CardContext): ChatCardView | null {
  if (row.card === null) {
    const noHold = row.role === "glim" && context.eventLive && context.state.holdCents === null && asksForBiddingPower(row.text);
    return noHold ? setPowerCard(context.slug) : null;
  }
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
  if (type === "autopilot") return autopilotCardView(row.card as AutopilotCard, context);
  if (type === "autopilot_raise") return raiseCardView(row.card as AutopilotRaiseCard, context);
  return null;
}

/**
 * What the guest last asked and how Glim answered, for the quick replies. Only while that answer is
 * the newest line: a card posted since (a rival's bid, say) puts the row back to the plan's own.
 */
function lastExchange(rows: readonly MessageRow[]): LastExchange {
  const talked = rows.some((row) => row.role === "guest");
  const last = rows.at(-1);
  const cardType = (last?.card as { type?: unknown } | null | undefined)?.type;
  const isReply = last?.role === "glim" && (last.card === null || cardType === "hold" || last.card_type === "plan");
  if (!last || !isReply) return { talked, failedGuestText: null, refused: false };
  const asked = [...rows].reverse().find((row) => row.role === "guest");
  return {
    talked,
    failedGuestText: last.error !== null && asked ? asked.text : null,
    refused: last.card_type !== "plan" && (last.refused || cardType === "hold"),
  };
}

interface ClosingFacts {
  wonCents: number;
  wonCount: number;
  wonInPlan: number;
  planLots: number;
  holdCents: number | null;
  charged: boolean;
}

/** design/22 #12: "9:30 PM · BIDDING CLOSED", what the guest won and pays, and the receipt. */
export function closingCard(input: { at: Date; timezone: string; slug: string; facts: ClosingFacts }): ClosingCardView {
  const { facts } = input;
  return {
    type: "closing",
    eyebrow: eventEyebrow(input.at, input.timezone, "Bidding closed"),
    line: biddingClosedLine(facts),
    receipt: facts.wonCount > 0 ? { label: "See my receipt", href: `/e/${encodeURIComponent(input.slug)}/receipt` } : null,
  };
}

/**
 * The lots the guest put in their plan themselves: their latest confirmed plan's lots, without the
 * backups the autopilot moved money to. "Skip the spa" and "both lots in your plan" are about these.
 */
async function loadGuestPlanLots(database: DatabaseClient, paddleId: string): Promise<Set<number>> {
  const { rows } = await database.pool.query<{ number: number; mandate: unknown; lot_id: string }>(
    `select l.number, l.id as lot_id, g.mandate from glim_plan_items i
     join lots l on l.id = i.lot_id
     join glim_plans g on g.id = i.plan_id
     where i.status <> 'skipped' and i.plan_id = (
       select id from glim_plans where paddle_id = $1 and confirmed_at is not null order by confirmed_at desc limit 1)`,
    [paddleId],
  );
  const mandate = parseMandate(rows[0]?.mandate);
  const planned = mandate ? new Set(mandate.lots.filter((lot) => lot.role === "plan").map((lot) => lot.lotNumber)) : null;
  return new Set(rows.map((row) => row.number).filter((number) => planned === null || planned.has(number)));
}

async function loadClosingFacts(database: DatabaseClient, paddleId: string, state: GlimState, planLots: ReadonlySet<number>): Promise<ClosingFacts> {
  // The bidding power the guest held, never a late approval that was refused and voided (11 reads
  // the same hold). Charged once settlement finished the paddle's item, or once that hold ended
  // without one (PayPal voided it, or it expired): nothing is held any more either way.
  const hold = await readBiddingHold(database.pool, paddleId);
  const won = state.lots.filter((lot) => lot.guestStatus === "won");
  return {
    wonCents: won.reduce((sum, lot) => sum + (lot.currentBidCents ?? 0), 0),
    wonCount: won.length,
    wonInPlan: won.filter((lot) => planLots.has(lot.number)).length,
    planLots: planLots.size,
    holdCents: hold?.amountCents ?? null,
    charged: hold !== null && (hold.settled || hold.status !== "authorized"),
  };
}

export async function loadChatView(viewer: ChatViewer, database: DatabaseClient = getDatabaseClient()): Promise<ChatView> {
  const { pool } = database;
  const [state, event, messages, plans, titles, deciding, openRaise] = await Promise.all([
    loadGlimState({ paddleId: viewer.paddleId, now: frozenNow(viewer.eventSlug) }, database),
    pool.query<{ status: EventStatus; closes_at: Date; closed_at: Date | null }>(
      "select status, closes_at, closed_at from events where id = $1",
      [viewer.eventId],
    ),
    pool.query<MessageRow>(
      // refused: proposals code turned down in the turn this reply answered (design/22 #5, #6).
      `select m.id, m.role, m.text, m.card_type, m.card, m.plan_id, m.error,
         (m.role = 'glim' and exists (
           select 1 from glim_actions a
           where a.paddle_id = m.paddle_id and a.kind = 'proposal_rejected' and a.created_at <= m.created_at
             and a.created_at > coalesce((select max(g.created_at) from chat_messages g
                                          where g.paddle_id = m.paddle_id and g.role = 'guest' and g.created_at < m.created_at), '-infinity')
         )) as refused
       from chat_messages m
       where m.paddle_id = $1 order by m.created_at, m.id`,
      [viewer.paddleId],
    ),
    pool.query<PlanRow>("select id, status, confirmed_at, paused_at, ended_at from glim_plans where paddle_id = $1", [viewer.paddleId]),
    pool.query<{ id: string; title: string }>("select id, title from lots where event_id = $1", [viewer.eventId]),
    pool.query<{ deciding: boolean }>(
      `select exists (
         select 1 from event_log d
         where d.paddle_id = $1 and d.type = 'glim' and d.payload->>'kind' = 'autopilot_deciding'
           and d.created_at > clock_timestamp() - make_interval(secs => $2)
           and not exists (select 1 from event_log f
                           where f.paddle_id = $1 and f.type = 'glim' and f.payload->>'kind' = 'autopilot_finished'
                             and f.payload->>'runId' = d.payload->>'runId')
       ) as deciding`,
      [viewer.paddleId, DECIDING_STALE_SECONDS],
    ),
    loadOpenRaiseOffer(pool, viewer.paddleId),
  ]);
  const eventRow = event.rows[0];
  if (!state || !eventRow) throw new Error(`No paddle ${viewer.paddleId} in event ${viewer.eventId}`);

  const eventLive = eventRow.status === "live";
  const ended = eventHasEnded(eventRow.status);
  const context: CardContext = {
    state,
    eventLive,
    slug: viewer.eventSlug,
    plans: new Map(plans.rows.map((row) => [row.id, row])),
    titles: new Map(titles.rows.map((row) => [row.id, row.title])),
    openRaise,
  };
  const running = plans.rows.find((plan) => plan.status === "active" || plan.status === "paused");
  const closedAt = eventRow.closed_at ?? eventRow.closes_at;
  const guestPlanLots = await loadGuestPlanLots(database, viewer.paddleId);
  return {
    firstName: viewer.firstName,
    paddleNumber: viewer.paddleNumber,
    greeting: state.holdCents === null ? `Hi ${viewer.firstName}. ${NO_HOLD_LINE}` : greeting(viewer.firstName),
    greetingCard: state.holdCents === null && eventLive ? setPowerCard(viewer.eventSlug) : null,
    status: chatStatus({
      state,
      eventStatus: eventRow.status,
      closedAt: eventRow.closed_at,
      closesAt: eventRow.closes_at,
      pausedAt: running?.paused_at ?? null,
      deciding: deciding.rows[0]?.deciding === true,
    }),
    planControl: !eventLive ? null : state.plan?.status === "active" ? "pause" : state.plan?.status === "paused" ? "resume" : null,
    messages: messages.rows.map(
      (row): ChatMessageView => ({ id: row.id, role: row.role, text: row.text, card: cardView(row, context) }),
    ),
    closing: ended
      ? closingCard({ at: closedAt, timezone: state.event.timezone, slug: viewer.eventSlug, facts: await loadClosingFacts(database, viewer.paddleId, state, guestPlanLots) })
      : null,
    quickReplies: chatQuickReplies({ state, eventLive, slug: viewer.eventSlug, last: lastExchange(messages.rows), guestPlanLots }),
    inputClosed: ended ? BIDDING_CLOSED_INPUT : null,
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
