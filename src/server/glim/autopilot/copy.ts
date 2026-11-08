/**
 * Every line an autopilot card shows that code writes (docs/planning/glim-autopilot.md §6.2, §11).
 * "What" is always code, built from the engine's actual result; "why" is the model's sentence
 * only after filterWhy and only when its decision was applied as decided, else a template. The
 * lines below follow the copy proposed in §11 V1–V3; none of it is approved yet, and no UI shows
 * it before the image approvals.
 */
import { foldGuestText, hasBannedClaim } from "../bannedWords";
import type { PlanCard } from "../cards";
import { rankedMandateLots, type GlimMandate } from "../mandate";
import { formatUsd, spelledOutAmountIndex } from "../money";
import { timeFormatter } from "../prompt";

import { plainTitle } from "./prompt";
import type { AutopilotChange, AutopilotContext, AutopilotDecider, AutopilotTrigger, DecisionReason } from "./types";

const MAX_WHY = 140;
/** Sureness a one-line why has no business showing; a chat reply may say "certainly". */
const OVERSURE_WHY = /\bpromise[sd]?\b|\bdefinite(?:ly)?\b|\bcertain(?:ly|ty)?\b/i;
const CURRENCY_WHY = /\$|\busd\b|dollar|\bbucks?\b|\bgrand\b/i;
const MARKUP_WHY = /https?:\/\/|www\.|[<>`]/i;

/**
 * The model's why, or null when the template must be shown instead: one line of at most 140
 * characters, with no digits or spelled-out amounts, no currency, no links or markup, no
 * exclamation mark, and nothing that promises a win or reads as tax advice. The checks run on
 * the folded text, so look-alike forms ("ｔａｘ", a zero-width space inside a word) fail as well.
 */
export function filterWhy(why: string): string | null {
  const text = why.trim();
  if (!text || text.length > MAX_WHY || /[\r\n\u2028\u2029]/.test(text)) return null;
  const folded = foldGuestText(text);
  if (/\p{N}/u.test(folded) || spelledOutAmountIndex(folded) >= 0) return null;
  if (CURRENCY_WHY.test(folded) || MARKUP_WHY.test(folded) || OVERSURE_WHY.test(folded) || hasBannedClaim(folded) || folded.includes("!")) return null;
  return text;
}

/** A card's figures, with every amount it shows (they join the chat snapshot's allowed amounts). */
class Lines {
  readonly amounts = new Set<number>();
  usd = (cents: number): string => {
    this.amounts.add(cents);
    return formatUsd(cents);
  };
}

function joinList(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]}, ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conjunction} ${items.at(-1)}`;
}

function joinPlain(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** What the engine did, as the apply transaction read it from createLimits or removeLimit. */
export interface AppliedFacts {
  paddleId: string;
  /** Bids placed by this change, in order: Glim's and any rival limits' answers. */
  bids: readonly { id: string; lotId: string; paddleId: string; amountCents: number; source: string }[];
  /** Limits created by this change; inactive ones were outbid at once. */
  limits: readonly { id: string; lotId: string; maxCents: number; active: boolean }[];
  /** Each lot the change touched, after it. */
  lots: readonly { lotId: string; currentBidCents: number | null; highPaddleId: string | null }[];
}

export interface ChangeLines {
  mainLotId: string;
  mainLotNumber: number;
  eyebrow: string;
  triggerLine: string | null;
  whatLine: string;
  chip: { kind: "winning"; amountCents: number } | null;
  /** True when a live lot was lowered or dropped so a higher-ranked one could gain. */
  priorityCall: boolean;
  /** Every amount the lines show. */
  amountsCents: number[];
}

interface LotMove {
  lotId: string;
  lotNumber: number;
  before: number | null;
  after: number | null;
}

function moves(change: AutopilotChange): LotMove[] {
  const after = new Map(change.after.map((lot) => [lot.lotId, lot]));
  const result: LotMove[] = change.before.map((lot) => ({
    lotId: lot.lotId,
    lotNumber: lot.lotNumber,
    before: lot.maxCents,
    after: after.get(lot.lotId)?.maxCents ?? null,
  }));
  for (const lot of change.after) {
    if (!change.before.some((entry) => entry.lotId === lot.lotId)) {
      result.push({ lotId: lot.lotId, lotNumber: lot.lotNumber, before: null, after: lot.maxCents });
    }
  }
  return result;
}

/** The lot a change is about: the added lot with the most money, else the one that gained most, else the first that lost. */
export function mainMove(change: AutopilotChange, mandate: GlimMandate): LotMove | null {
  const all = moves(change);
  const rank = (lotId: string) => mandate.lots.find((lot) => lot.lotId === lotId)?.rank ?? Number.POSITIVE_INFINITY;
  const byRank = (a: LotMove, b: LotMove) => rank(a.lotId) - rank(b.lotId) || a.lotNumber - b.lotNumber;
  const added = all.filter((move) => move.before === null && move.after !== null);
  if (added.length > 0) return [...added].sort((a, b) => (b.after ?? 0) - (a.after ?? 0) || byRank(a, b))[0] ?? null;
  const gained = all.filter((move) => move.before !== null && move.after !== null && move.after > move.before);
  if (gained.length > 0) {
    return [...gained].sort((a, b) => (b.after ?? 0) - (b.before ?? 0) - ((a.after ?? 0) - (a.before ?? 0)) || byRank(a, b))[0] ?? null;
  }
  const lost = all.filter((move) => move.before !== null && (move.after === null || move.after < move.before));
  return [...lost].sort(byRank)[0] ?? null;
}

function lotTitle(context: AutopilotContext, lotId: string, lotNumber: number): string {
  return plainTitle(context.state.lots.find((lot) => lot.id === lotId), lotNumber);
}

/** "1 minute left on Chef’s Table." for closing_soon, "Your $600 is held with PayPal." for hold_raised. */
export function triggerLine(trigger: AutopilotTrigger | null, context: AutopilotContext, usd: (cents: number) => string = formatUsd): string | null {
  if (!trigger) return null;
  if (trigger.kind === "hold_raised") return `Your ${usd(trigger.amountCents)} is held with PayPal.`;
  if (trigger.kind !== "closing_soon") return null;
  const left = Date.parse(trigger.closesAt) - context.state.now.getTime();
  const title = lotTitle(context, trigger.lotId, trigger.lotNumber);
  return left < 60_000 ? `Under a minute left on ${title}.` : `1 minute left on ${title}.`;
}

/** The card's footer: "Your rules: $500 in all · Spa Day up to $120". */
export function rulesLine(context: AutopilotContext, usd: (cents: number) => string = formatUsd): string {
  const { mandate, state } = context;
  const parts = [
    mandate.budgetCents === null ? `up to your ${usd(state.holdCents ?? 0)} bidding power` : `${usd(mandate.budgetCents)} in all`,
  ];
  for (const lot of rankedMandateLots(mandate)) {
    if (lot.capCents !== null) parts.push(`${lotTitle(context, lot.lotId, lot.lotNumber)} up to ${usd(lot.capCents)}`);
  }
  const never = mandate.excludedLotIds.flatMap((lotId) => {
    const lot = state.lots.find((candidate) => candidate.id === lotId);
    return lot ? [plainTitle(lot, lot.number)] : [];
  });
  if (never.length > 0) parts.push(`never ${joinPlain(never, "or")}`);
  return `Your rules: ${parts.join(" · ")}`;
}

/** "9:15 PM · CHEF’S TABLE → WINE TASTING". */
function eyebrow(context: AutopilotContext, fromTitle: string | null, toTitle: string): string {
  const time = timeFormatter(context.state.event.timezone, false)(context.state.now);
  const upper = (text: string) => text.toLocaleUpperCase("en-US");
  if (!fromTitle || fromTitle === toTitle) return `${time} · ${upper(toTitle)}`;
  return `${time} · ${upper(fromTitle)} → ${upper(toTitle)}`;
}

/**
 * The card's eyebrow, trigger line and "what" sentence, from what the engine actually did:
 * "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380."
 */
export function changeLines(input: {
  change: AutopilotChange;
  context: AutopilotContext;
  applied: AppliedFacts;
  trigger: AutopilotTrigger | null;
}): ChangeLines {
  const { change, context, applied } = input;
  const lines = new Lines();
  const { usd } = lines;
  const main = mainMove(change, context.mandate);
  if (!main) throw new Error("changeLines needs a change that moves at least one limit");
  const rank = (lotId: string) => context.mandate.lots.find((lot) => lot.lotId === lotId)?.rank ?? Number.POSITIVE_INFINITY;
  const title = (move: Pick<LotMove, "lotId" | "lotNumber">) => lotTitle(context, move.lotId, move.lotNumber);
  const mainTitle = title(main);
  const all = moves(change);
  const losers = all.filter(
    (move) => move.lotId !== main.lotId && move.before !== null && (move.after === null || move.after < move.before),
  );
  const mainGains = main.after !== null && main.after > (main.before ?? 0);
  const priorityCall = mainGains && losers.some((loser) => rank(loser.lotId) > rank(main.lotId));

  const lot = applied.lots.find((entry) => entry.lotId === main.lotId);
  const leading = lot?.highPaddleId === applied.paddleId;
  const glimBid = [...applied.bids].reverse().find((bid) => bid.lotId === main.lotId && bid.paddleId === applied.paddleId);
  const created = applied.limits.find((limit) => limit.lotId === main.lotId);
  const outbid = created !== undefined && !created.active;
  const maxCents = main.after ?? 0;

  let what: string;
  const mentioned = new Set<string>([main.lotId]);
  if (priorityCall) {
    const phrases = losers
      .filter((loser) => rank(loser.lotId) > rank(main.lotId))
      .map((loser) => {
        mentioned.add(loser.lotId);
        return loser.after === null ? `stopped bidding on ${title(loser)}` : `lowered ${title(loser)} to ${usd(loser.after)}`;
      });
    what = `I ${joinPlain(phrases, "and")} so ${mainTitle} can go up to ${usd(maxCents)}.`;
    if (main.before === null && glimBid && leading) what += ` I bid ${usd(glimBid.amountCents)} for you.`;
  } else if (main.before === null) {
    const isPlanLot = context.mandate.lots.find((entry) => entry.lotId === main.lotId)?.role === "plan";
    const start = isPlanLot ? `I’m back on ${mainTitle}` : `I moved the ${usd(maxCents)} left to ${mainTitle}`;
    if (outbid) what = `${start}, but another bidder’s limit there is higher.`;
    else if (leading && glimBid) what = `${start}. I bid ${usd(glimBid.amountCents)} for you and will go up to ${usd(maxCents)}.`;
    else if (leading && lot?.currentBidCents != null) {
      what = `${start}. You’re winning at ${usd(lot.currentBidCents)}, and I’ll go up to ${usd(maxCents)}.`;
    } else what = `${start}. I’ll go up to ${usd(maxCents)}.`;
  } else if (mainGains) {
    what = `I added the ${usd(maxCents - (main.before ?? 0))} left to ${mainTitle}. It can now go up to ${usd(maxCents)}.`;
    if (glimBid && leading) what += ` I bid ${usd(glimBid.amountCents)} for you.`;
  } else if (main.after === null) {
    // Only what the apply read under the lot lock: a bid placed while the model decided changes it.
    const standing = leading ? (lot?.currentBidCents ?? null) : null;
    what = standing === null ? `I stopped bidding on ${mainTitle}.` : `I stopped bidding on ${mainTitle}. Your ${usd(standing)} bid stands.`;
  } else {
    what = `I lowered ${mainTitle} to ${usd(maxCents)}.`;
  }
  const otherDrops = losers.filter((loser) => loser.after === null && !mentioned.has(loser.lotId)).map(title);
  if (otherDrops.length > 0) what += ` I stopped bidding on ${joinPlain(otherDrops, "and")}.`;

  const trigger = input.trigger;
  const fromLotId = trigger && trigger.kind !== "hold_raised" ? trigger.lotId : null;
  const fromTitle = trigger && trigger.kind !== "hold_raised" ? lotTitle(context, trigger.lotId, trigger.lotNumber) : null;
  const chipAmount = leading ? (lot?.currentBidCents ?? null) : null;
  const result: ChangeLines = {
    mainLotId: main.lotId,
    mainLotNumber: main.lotNumber,
    eyebrow: eyebrow(context, fromLotId === main.lotId ? null : fromTitle, mainTitle),
    triggerLine: triggerLine(trigger, context, usd),
    whatLine: what,
    chip: chipAmount === null ? null : { kind: "winning", amountCents: chipAmount },
    priorityCall,
    amountsCents: [],
  };
  if (chipAmount !== null) lines.amounts.add(chipAmount);
  result.amountsCents = [...lines.amounts];
  return result;
}

/** The why when the model's is not shown, by what happened and where the money went. */
export function templateWhy(input: {
  context: AutopilotContext;
  decidedBy: AutopilotDecider;
  reason: DecisionReason;
  mainLotId: string | null;
  priorityCall: boolean;
  topUp: boolean;
  trigger: AutopilotTrigger | null;
}): string {
  if (input.decidedBy === "pending_raise") return "You approved the raise for this lot.";
  if (input.priorityCall) return "You ranked it higher.";
  if (input.topUp && input.trigger?.kind === "lot_won") return "That money was free after your win.";
  const mandated = input.context.mandate.lots.find((lot) => lot.lotId === input.mainLotId);
  if (!mandated) return "It keeps your plan inside your rules.";
  if (mandated.role === "backup") return mandated.source === "heart" ? "It’s a lot you hearted." : "It’s the backup you named.";
  const topRank = rankedMandateLots(input.context.mandate)[0]?.rank;
  return mandated.rank === topRank ? "It’s the lot you ranked first." : "It’s one of the lots you planned.";
}

export interface AutopilotCard {
  type: "autopilot";
  runId: string;
  actionId: string;
  /** ISO instant of the decision. */
  at: string;
  eyebrow: string;
  /** Null when the engine's own event card already told the fact (limit_exhausted, lot_won, lot_lost). */
  triggerLine: string | null;
  whatLine: string;
  whyLine: string;
  whySource: "model" | "template";
  chip: { kind: "winning"; amountCents: number } | null;
  rulesLine: string;
  /** For an added lot: the guest may end Glim's limit there (skipLot). */
  skip: { lotId: string; label: string } | null;
}

export function autopilotCard(input: {
  runId: string;
  actionId: string;
  context: AutopilotContext;
  lines: ChangeLines;
  change: AutopilotChange;
  why: string;
  whySource: "model" | "template";
}): AutopilotCard {
  const { lines, context } = input;
  const added = !input.change.before.some((lot) => lot.lotId === lines.mainLotId);
  return {
    type: "autopilot",
    runId: input.runId,
    actionId: input.actionId,
    at: context.state.now.toISOString(),
    eyebrow: lines.eyebrow,
    triggerLine: lines.triggerLine,
    whatLine: lines.whatLine,
    whyLine: input.why,
    whySource: input.whySource,
    chip: lines.chip,
    rulesLine: rulesLine(context),
    skip: added ? { lotId: lines.mainLotId, label: `Skip ${lotTitle(context, lines.mainLotId, lines.mainLotNumber)}` } : null,
  };
}

export interface RaiseLines {
  eyebrow: string;
  askLine: string;
  approveLabel: string;
  dismissLabel: string;
  note: string;
  endedLabel: string;
  amountsCents: number[];
}

/** V3: "Chef’s Table now needs more than your $500 bidding power. Approve $600 and I’ll keep bidding on it." */
export function raiseLines(input: { context: AutopilotContext; lotId: string; lotNumber: number; amountCents: number }): RaiseLines {
  const { context } = input;
  const lines = new Lines();
  const { usd } = lines;
  const title = lotTitle(context, input.lotId, input.lotNumber);
  const hold = context.state.holdCents ?? 0;
  const budget = context.mandate.budgetCents ?? input.amountCents;
  const time = timeFormatter(context.state.event.timezone, false)(context.state.now);
  const result: RaiseLines = {
    eyebrow: `${time} · ${title.toLocaleUpperCase("en-US")}`,
    askLine: `${title} now needs more than your ${usd(hold)} bidding power. Approve ${usd(input.amountCents)} and I’ll keep bidding on it.`,
    approveLabel: `Approve ${usd(input.amountCents)} in PayPal`,
    dismissLabel: "Not now",
    note: `This opens PayPal to approve a ${usd(input.amountCents)} hold, within the ${usd(budget)} you named. You pay only for the lots you win.`,
    endedLabel: "This offer ended",
    amountsCents: [],
  };
  result.amountsCents = [...lines.amounts];
  return result;
}

export interface AutopilotRaiseCard {
  type: "autopilot_raise";
  runId: string;
  actionId: string;
  at: string;
  eyebrow: string;
  askLine: string;
  whyLine: string;
  whySource: "model" | "template";
  approveLabel: string;
  dismissLabel: string;
  note: string;
  endedLabel: string;
  /** The total bidding power to approve; the button reads it from the stored action, never the request. */
  amountCents: number;
  currentHoldCents: number;
  budgetCents: number;
  lotId: string;
  /** When the offer ends unless one of its lots closes first. */
  expiresAt: string;
}

export function autopilotRaiseCard(input: {
  runId: string;
  actionId: string;
  context: AutopilotContext;
  lines: RaiseLines;
  lotId: string;
  amountCents: number;
  why: string;
  whySource: "model" | "template";
  expiresAt: Date;
}): AutopilotRaiseCard {
  const { context, lines } = input;
  return {
    type: "autopilot_raise",
    runId: input.runId,
    actionId: input.actionId,
    at: context.state.now.toISOString(),
    eyebrow: lines.eyebrow,
    askLine: lines.askLine,
    whyLine: input.why,
    whySource: input.whySource,
    approveLabel: lines.approveLabel,
    dismissLabel: lines.dismissLabel,
    note: lines.note,
    endedLabel: lines.endedLabel,
    amountCents: input.amountCents,
    currentHoldCents: context.state.holdCents ?? 0,
    budgetCents: context.mandate.budgetCents ?? input.amountCents,
    lotId: input.lotId,
    expiresAt: input.expiresAt.toISOString(),
  };
}

export interface PlanCardAutopilotLines {
  eyebrow: "ON MY OWN";
  body: string;
  backups: { lotId: string; title: string; sourceLabel: string; statusText: string }[];
  rules: string;
}

/** V1: the plan card's "ON MY OWN" block, or null when autopilot is off. */
export function planCardAutopilotLines(card: PlanCard): PlanCardAutopilotLines | null {
  if (!card.autopilot) return null;
  const usd = formatUsd;
  const body =
    card.backups.length === 0
      ? "If a lot gets away, I’ll move its money to your other lots, and tell you why."
      : `If a lot gets away, I’ll move its money to your other lots or ${card.backups.length === 1 ? "this backup" : "these backups"}, and tell you why.`;
  // The budget confirming this card gives Glim, which a change card may keep from the running plan.
  const budget = card.mandateBudgetCents;
  const first = budget === null ? `your ${usd(card.holdCents)} bidding power` : `${usd(budget)} in all`;
  const caps = card.items
    .filter((item) => item.capCents !== null)
    .map((item) => `${plainTitle(item, item.lotNumber)} up to ${usd(item.capCents ?? 0)}`);
  let rules = `Never past ${joinList([first, ...caps], "and")}.`;
  if (card.excluded.length > 0) {
    rules += ` I won’t bid on ${joinPlain(card.excluded.map((lot) => plainTitle(lot, lot.lotNumber)), "or")}.`;
  }
  if (budget !== null && budget > card.holdCents) {
    rules += ` If a lot needs more than your ${usd(card.holdCents)} bidding power, I’ll ask you to approve more in PayPal, up to the ${usd(budget)} you named.`;
  }
  return {
    eyebrow: "ON MY OWN",
    body,
    backups: card.backups.map((backup) => ({
      lotId: backup.lotId,
      title: plainTitle(backup, backup.lotNumber),
      sourceLabel: backup.source === "heart" ? "You hearted it" : "Backup you named",
      statusText: backup.statusText,
    })),
    rules,
  };
}
