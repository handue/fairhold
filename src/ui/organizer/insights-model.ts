/**
 * What Insights (design/28) says and where its charts' marks go, with no React, so it is tested on
 * its own. The board draws the report once charged, on the fixture's figures; while bidding runs
 * every widget says what it is now, and before the charge it says what will be charged.
 */
import type { InsightsLot, InsightsView, RaisedPoint } from "@/server/settlement/types";
import { formatClockTime, formatLotNumber, formatUsd } from "@/ui/format";

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const percent = (share: number) => `${Math.round(share * 100)}%`;

export interface Kpi {
  label: string;
  value: string;
  /** An amount, set in Money's mono with its commas pulled in; null for a count. */
  cents: number | null;
  /** The muted "of 24" after the figure. */
  of: string | null;
  sub: string;
}

export interface InsightsCopy {
  /** "85 of the 86 bidders are simulated guests.", only where it is so. */
  note: string | null;
  kpis: [Kpi, Kpi, Kpi, Kpi];
  limits: { figure: string; sub: string; foot: string[] };
  holds: { figure: string; sub: string; ends: [string, string] | null; foot: string };
  topLots: { note: string; amountHeader: string };
}

function lotsSub(view: InsightsView): string {
  if (view.phase === "live") return view.lots.open === 0 ? "Every lot has closed" : `${plural(view.lots.open, "lot")} still open`;
  const { withoutBids } = view.lots;
  const only = withoutBids[0];
  if (withoutBids.length === 0) return "Every lot had bids";
  if (withoutBids.length === 1 && only) return `Lot ${formatLotNumber(only.number)} had no bids`;
  return `${withoutBids.length} lots had no bids`;
}

function holdsCopy(view: InsightsView): InsightsCopy["holds"] {
  const { heldCents, chargedCents, winnerHoldCents, winnerShares, nonWinners } = view.holds;
  const winners = winnerShares.length;
  const share = heldCents > 0 ? chargedCents / heldCents : 0;
  const used = percent(winnerHoldCents > 0 ? chargedCents / winnerHoldCents : 0);
  const first = winnerShares[0];
  const last = winnerShares[winnerShares.length - 1];
  const ends: [string, string] | null = first !== undefined && last !== undefined ? [percent(first), percent(last)] : null;
  const held = formatUsd(heldCents);
  const theWinners = `The ${plural(winners, "winner")}`;
  const theOthers = `The other ${nonWinners}`;

  switch (view.phase) {
    case "live":
      return {
        figure: percent(share),
        sub: `of the ${held} held is bid now`,
        ends,
        foot: `${winners === 1 ? "The bidder winning now uses" : `The ${winners} bidders winning now use`} ${used} of their holds.`,
      };
    case "ready":
    case "charging":
    case "failed":
      return {
        figure: percent(share),
        sub: `of the ${held} held will be charged`,
        ends,
        foot: `${theWinners} will use ${used} of their holds. ${theOthers} will have theirs released in full.`,
      };
    case "charged":
    case "ended":
      return {
        figure: percent(share),
        sub: `of the ${held} held was charged`,
        ends,
        foot: `${theWinners} used ${used} of their holds. ${theOthers} had theirs released in full.`,
      };
  }
}

/** "85 of the 86 bidders are simulated guests.", or every one of them before a real guest holds. */
function simulatedNote(simulated: number, bidders: number): string {
  if (simulated === bidders) return simulated === 1 ? "The one bidder is a simulated guest." : `All ${bidders} bidders are simulated guests.`;
  return `${simulated} of the ${bidders} bidders ${simulated === 1 ? "is a simulated guest" : "are simulated guests"}.`;
}

export function insightsCopy(view: InsightsView): InsightsCopy {
  const { limits, bids, winners } = view;
  const live = view.phase === "live";
  return {
    note: view.saySimulated ? simulatedNote(view.simulatedBidders, view.bidders) : null,
    kpis: [
      { label: "Raised", value: formatUsd(view.raisedCents), cents: view.raisedCents, of: null, sub: `for ${view.event.charityName}` },
      { label: "Lots sold", value: String(view.lots.sold), cents: null, of: `of ${view.lots.total}`, sub: lotsSub(view) },
      {
        label: "Bids",
        value: String(bids.total),
        cents: null,
        of: null,
        sub: bids.glim === 0 ? "None by Glim" : `${bids.glim} of them by Glim`,
      },
      {
        label: "Winners",
        value: String(winners.count),
        cents: null,
        of: `of ${view.bidders}`,
        sub: winners.glim === 0 ? "Glim bid for none of them" : `Glim bid for ${winners.glim} of the ${winners.count}`,
      },
    ],
    limits: {
      figure: `${limits.glimBidsWithin} of ${limits.glimBids}`,
      sub: limits.glimBids === 0 ? "Glim hasn’t bid yet" : "bids by Glim stayed within their limits",
      foot: [plural(limits.shares.length, "limit"), `${limits.reached} reached`, `${limits.passed} passed`],
    },
    holds: holdsCopy(view),
    topLots: {
      note: live
        ? `${Math.min(TOP_LOTS, topLotRows(view).length)} of ${topLotRows(view).length} with bids`
        : `${Math.min(TOP_LOTS, topLotRows(view).length)} of ${view.lots.sold} sold`,
      amountHeader: live ? "High bid" : "Sold for",
    },
  };
}

/** The grid's page: the top five by whatever it is sorted on. */
export const TOP_LOTS = 5;

/** Lots that sold, or while bidding runs the lots with a bid: the rows "Top lots" ranks. */
export function topLotRows(view: Pick<InsightsView, "lotRows" | "phase">): InsightsLot[] {
  return view.lotRows.filter((lot) => lot.amountCents !== null && (view.phase === "live" || (lot.closed && lot.paddleNumber !== null)));
}

// "Raised through the evening" -----------------------------------------------------------------------

/** The drawn chart: 778 by 216, the plot from x 52 to 720 and from y 194 ($0) up to 10. */
export const CHART = { width: 778, height: 216, left: 52, right: 720, bottom: 194, top: 10 } as const;
/**
 * Below 1440 the widget draws the chart at its own width, so the labels keep their 11px: the plot
 * keeps its margins, and the round times thin out with the room.
 */
export const CHART_MIN_WIDTH = 220;
const CHART_LABELS = 5;
const NICE = [1, 2, 2.5, 5] as const;

/** The value of the top gridline: four even steps whose top is the evening's figure or just under it. */
export function chartTop(maxCents: number): number {
  const wanted = Math.max(maxCents * 0.95, 100_000) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(wanted));
  for (const factor of [...NICE, 10]) {
    const step = factor * magnitude;
    if (step >= wanted) return Math.round(step * 4);
  }
  return Math.round(wanted * 4);
}

export interface ChartLabel {
  x: number;
  y: number;
  text: string;
  anchor: "start" | "middle" | "end";
}

export interface RaisedChart {
  /** The plot's right edge, where the gridlines end: CHART.right at the drawn width. */
  right: number;
  gridlines: { y: number; label: string }[];
  xLabels: ChartLabel[];
  line: string;
  area: string;
  end: { x: number; y: number; label: string } | null;
  aria: string;
}

const MINUTE = 60_000;
const LABEL_STEPS_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440] as const;
/**
 * A round time this close to either end is left out, so labels never touch. The ends carry the
 * wider "12:40 PM" anchored at the edge (about 50 units), and a round time is centred ("12:30", about
 * 32 units), so they need 50 + 16 and a gap.
 */
const LABEL_CLEARANCE = 80;

const fixed = (value: number) => value.toFixed(1);

/** Minutes past midnight in the event's time zone, for round labels on the hour and half hour. */
function minutesOfDay(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function raisedChart(
  points: readonly RaisedPoint[],
  window: { opensAt: number; closesAt: number },
  timeZone: string,
  width: number = CHART.width,
): RaisedChart {
  const right = Math.max(CHART_MIN_WIDTH, width) - (CHART.width - CHART.right);
  const span = Math.max(1, window.closesAt - window.opensAt);
  const max = points.reduce((most, point) => Math.max(most, point.cents), 0);
  const top = chartTop(max);
  const xOf = (at: number) => CHART.left + ((Math.min(Math.max(at, window.opensAt), window.closesAt) - window.opensAt) / span) * (right - CHART.left);
  const yOf = (cents: number) => CHART.bottom - (cents / top) * (CHART.bottom - CHART.top);

  const gridlines = [0, 1, 2, 3, 4].map((step) => ({ y: yOf((top / 4) * step), label: formatUsd((top / 4) * step) }));

  const spanMinutes = span / MINUTE;
  // Five spans across the drawn plot, fewer across a narrower one.
  const spans = Math.max(1, (CHART_LABELS * (right - CHART.left)) / (CHART.right - CHART.left));
  const every = LABEL_STEPS_MINUTES.find((minutes) => spanMinutes / minutes <= spans) ?? 1440;
  const startMinutes = minutesOfDay(window.opensAt, timeZone);
  const xLabels: ChartLabel[] = [{ x: CHART.left, y: 212, text: formatClockTime(window.opensAt, timeZone), anchor: "start" }];
  const firstRound = Math.ceil((startMinutes + 0.001) / every) * every;
  for (let minutes = firstRound; ; minutes += every) {
    const at = window.opensAt + (minutes - startMinutes) * MINUTE - (window.opensAt % MINUTE);
    if (at >= window.closesAt) break;
    const x = xOf(at);
    if (x - CHART.left < LABEL_CLEARANCE || right - x < LABEL_CLEARANCE) continue;
    xLabels.push({ x, y: 212, text: formatClockTime(at, timeZone).replace(/\s?[AP]M$/, ""), anchor: "middle" });
  }
  xLabels.push({ x: right, y: 212, text: formatClockTime(window.closesAt, timeZone), anchor: "end" });

  const marks = points.map((point) => `${fixed(xOf(point.at))} ${fixed(yOf(point.cents))}`);
  const line = marks.length > 0 ? `M${marks.join("L")}` : "";
  const last = points[points.length - 1];
  const first = points[0];
  const area = last && first ? `${line}L${fixed(xOf(last.at))} ${fixed(CHART.bottom)}L${fixed(xOf(first.at))} ${fixed(CHART.bottom)}Z` : "";
  const end = last ? { x: xOf(last.at), y: yOf(last.cents), label: formatUsd(last.cents) } : null;
  const aria = last && first
    ? `Raised through the evening, from ${formatUsd(first.cents)} at ${formatClockTime(first.at, timeZone)} to ${formatUsd(last.cents)} at ${formatClockTime(last.at, timeZone)}`
    : "Raised through the evening";
  return { right, gridlines, xLabels, line, area, end, aria };
}

/** The Raised widget's sparkline, 112 by 40: the same points, the evening across 108 and its figure up to 3. */
export function sparkline(points: readonly RaisedPoint[], window: { opensAt: number; closesAt: number }): { path: string; end: { x: number; y: number } } | null {
  const last = points[points.length - 1];
  if (!last) return null;
  const span = Math.max(1, window.closesAt - window.opensAt);
  const max = Math.max(1, last.cents, ...points.map((point) => point.cents));
  const xOf = (at: number) => ((at - window.opensAt) / span) * 108;
  const yOf = (cents: number) => 37 - (cents / max) * 34;
  return {
    path: `M${points.map((point) => `${fixed(xOf(point.at))} ${fixed(yOf(point.cents))}`).join("L")}`,
    end: { x: xOf(last.at), y: yOf(last.cents) },
  };
}

/** "Limits kept": a bar per limit, filled to Glim's highest bid there; one that crossed the line shows it. */
export function limitBarHeight(share: number): string {
  return `${Math.round(Math.min(share, 1.1) * 1000) / 10}%`;
}
