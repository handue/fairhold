/**
 * What the control room says, decided here with no React and no grid, so it can be tested on its own.
 * "Ready to charge" is the approved 12. The other phases are plain copy on the same layout until
 * Sheet C's design/24 is approved.
 */
import type {
  CheckKey,
  CheckProblem,
  LedgerItem,
  LedgerPhase,
  LedgerRow,
  LedgerView,
  SettlementChecks,
} from "@/server/settlement/types";
import { formatClockTime, formatLotNumber, formatPaddleNumber, formatUsd } from "@/ui/format";

export const LEDGER_PAGE_SIZE = 10;

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// Row status -----------------------------------------------------------------------------------------

/** The Status cell. Only a real hold says Charging or Charged; a simulated guest never touches PayPal. */
export function itemStatusLabel(item: LedgerItem): string {
  if (item.status === "failed") return "Failed";
  if (item.status === "pending") return "Waiting on PayPal";
  if (item.status === "queued") return "Queued";
  if (item.action === "simulate") return item.status === "succeeded" ? "Simulated" : "Settling…";
  if (item.action === "capture") return item.status === "succeeded" ? "Charged" : "Charging…";
  return item.status === "succeeded" ? "Released" : "Releasing…";
}

export function canRetry(item: LedgerItem | null): boolean {
  return item?.status === "failed" || item?.status === "pending";
}

/** A row class for the grid's rowClassRules. */
export function rowStatusClass(item: LedgerItem | null): "charging" | "charged" | "failed" | null {
  if (!item) return null;
  if (item.status === "failed") return "failed";
  if (item.status === "succeeded") return "charged";
  return item.status === "processing" ? "charging" : null;
}

// Filter chips ---------------------------------------------------------------------------------------

export type LedgerFilter = "all" | "winners" | "nothing";

export function filterPasses(filter: LedgerFilter, row: Pick<LedgerRow, "toChargeCents">): boolean {
  if (filter === "all") return true;
  return filter === "winners" ? row.toChargeCents > 0 : row.toChargeCents === 0;
}

export function filterLabels(phase: LedgerPhase): Record<LedgerFilter, string> {
  return phase === "live"
    ? { all: "All", winners: "Winning", nothing: "Not winning" }
    : { all: "All", winners: "Winners", nothing: "Won nothing" };
}

// Live updates ---------------------------------------------------------------------------------------

export interface LedgerRowChanges {
  add: LedgerRow[];
  update: LedgerRow[];
  remove: LedgerRow[];
}

/** The grid transaction from one read to the next; a row that did not change is not touched. */
export function diffLedgerRows(previous: readonly LedgerRow[], next: readonly LedgerRow[]): LedgerRowChanges {
  const before = new Map(previous.map((row) => [row.paddleId, row]));
  const after = new Set(next.map((row) => row.paddleId));
  const changes: LedgerRowChanges = { add: [], update: [], remove: [] };
  for (const row of next) {
    const old = before.get(row.paddleId);
    if (!old) changes.add.push(row);
    else if (JSON.stringify(old) !== JSON.stringify(row)) changes.update.push(row);
  }
  for (const row of previous) {
    if (!after.has(row.paddleId)) changes.remove.push(row);
  }
  return changes;
}

// CSV ------------------------------------------------------------------------------------------------

/**
 * A guest types their own first name, and a spreadsheet would run "=HYPERLINK(...)" as a formula. A
 * leading apostrophe makes any such cell plain text.
 */
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** The Hold column, which only the CSV shows: the honest label for each row. */
export function holdKindLabel(row: Pick<LedgerRow, "holdKind">): string {
  if (row.holdKind === "paypal") return "PayPal";
  return row.holdKind === "simulated" ? "Simulated, no PayPal" : "";
}

// Footer ---------------------------------------------------------------------------------------------

/** "Lot 22, Golf Lesson with a Pro, had no bids". */
export function withoutBidsLine(view: Pick<LedgerView, "lots" | "phase">): string | null {
  const { withoutBids } = view.lots;
  const live = view.phase === "live";
  if (withoutBids.length === 0) return null;
  if (withoutBids.length > 1) return `${withoutBids.length} lots ${live ? "have no bids yet" : "had no bids"}`;
  const lot = withoutBids[0];
  if (!lot) return null;
  return `Lot ${formatLotNumber(lot.number)}, ${lot.title}, ${live ? "has no bids yet" : "had no bids"}`;
}

export function lotsTotalLabel(view: Pick<LedgerView, "lots" | "phase">): string {
  const { total, sold, closed } = view.lots;
  return view.phase === "live" ? `${closed} of ${total} lots closed` : `${sold} of ${total} lots sold`;
}

export function lotsColumnHeader(phase: LedgerPhase): string {
  return phase === "live" ? "Winning now" : "Lots won";
}

// The rail -------------------------------------------------------------------------------------------

export interface RailFigure {
  cents: number;
  label: string;
}

export interface RailCopy {
  eyebrow: string;
  title: string;
  holdLine: string;
  holdSub: string;
  left: RailFigure;
  right: RailFigure;
  caption: [string, string];
  note: string | null;
}

/**
 * A demo mixes real holds with simulated guests, so "held with PayPal" would not be true of them. A
 * screen with only the seeded fixture's holds keeps the approved wording.
 */
function simulatedLine(view: LedgerView, verb: "settle" | "settled"): string | null {
  const { real, simulated } = view.holds;
  if (simulated === 0 || (!view.event.isDemo && real === 0)) return null;
  const without = verb === "settled" ? "settled" : simulated === 1 ? "settles" : "settle";
  return `The ${simulated === 1 ? "" : `${simulated} `}simulated ${simulated === 1 ? "guest" : "guests"} ${without} without PayPal.`;
}

export function railCopy(view: LedgerView): RailCopy {
  const { heldCents, toChargeCents, toReleaseCents } = view.totals;
  const bidders = plural(view.counts.all, "bidder");
  const honest = simulatedLine(view, "settle");
  const heldLine = honest ? `${formatUsd(heldCents)} held · ${bidders}` : `${formatUsd(heldCents)} held with PayPal · ${bidders}`;
  const settlement = view.settlement;
  const oneCharge: [string, string] = ["One charge per winner, for the lots they won.", "The rest of their hold is released at the same time."];

  switch (view.phase) {
    case "live":
      return {
        eyebrow: "Bidding open",
        title: `Closes at ${formatClockTime(view.event.closesAt, view.event.timeZone)}`,
        holdLine: heldLine,
        holdSub: honest ?? "Nothing is charged while bidding is open.",
        left: { cents: toChargeCents, label: "to charge" },
        right: { cents: toReleaseCents, label: "to release" },
        caption: [
          `If bidding ended now, ${plural(view.counts.winners, "winner")} would be charged.`,
          "Nothing is charged while bidding is open.",
        ],
        note: "These figures move as bids land.",
      };
    case "ready":
      return {
        eyebrow: "Bidding closed",
        title: view.checks.passed === false ? "Can’t charge yet" : "Ready to charge",
        holdLine: heldLine,
        holdSub: honest ?? "Nothing has been charged yet.",
        left: { cents: toChargeCents, label: "to charge" },
        right: { cents: toReleaseCents, label: "to release" },
        caption: oneCharge,
        note: "Bidders who won nothing have their whole hold released.",
      };
    case "charging":
      return {
        eyebrow: "Bidding closed",
        title: `Charging ${settlement?.winnersSettled ?? 0} of ${settlement?.winners ?? view.counts.winners}`,
        holdLine: heldLine,
        holdSub: honest ?? "Winners are being charged now.",
        left: { cents: settlement?.chargedCents ?? 0, label: "charged so far" },
        right: { cents: toChargeCents - (settlement?.chargedCents ?? 0), label: "still to charge" },
        caption: oneCharge,
        note: "You can leave this page. Charging keeps going.",
      };
    case "charged":
      return {
        eyebrow: "Bidding closed",
        title: `${plural(settlement?.winners ?? view.counts.winners, "winner")} charged`,
        holdLine: `Every hold is settled · ${bidders}`,
        holdSub: simulatedLine(view, "settled") ?? "Nothing more is held for this event.",
        left: { cents: settlement?.chargedCents ?? toChargeCents, label: "charged" },
        right: { cents: settlement?.releasedCents ?? toReleaseCents, label: "released" },
        caption: ["One charge per winner, for the lots they won.", "The rest of their hold was released at the same time."],
        note: "Bidders who won nothing had their whole hold released.",
      };
    case "failed":
      return failedCopy(view, honest);
    case "ended":
      return {
        eyebrow: "Bidding closed",
        title: "This event has ended",
        holdLine: `Nothing was charged · ${bidders}`,
        holdSub: "Every hold on this event is being released.",
        left: { cents: 0, label: "charged" },
        right: { cents: heldCents, label: "released" },
        caption: ["This event was closed without charging anyone.", "A new demo gala starts from the home page."],
        note: null,
      };
  }
}

/** PayPal's own words for "the buyer's funding said no", where a retry is a fair thing to offer. */
const DECLINE_CODES: ReadonlySet<string> = new Set([
  "CAPTURE_DECLINED",
  "INSTRUMENT_DECLINED",
  "PAYER_CANNOT_PAY",
  "PAYMENT_DENIED",
  "TRANSACTION_REFUSED",
]);

function failedCopy(view: LedgerView, honest: string | null): RailCopy {
  const settlement = view.settlement;
  const open = view.rows.filter((row) => canRetry(row.item));
  const only = open.length === 1 ? open[0] : null;
  const owedCents = open.reduce((sum, row) => sum + row.toChargeCents, 0);
  const declined = DECLINE_CODES.has(only?.item?.errorCode ?? "");

  let holdSub = "You can retry each one from its row.";
  if (only) {
    if (declined) holdSub = "PayPal declined this charge.";
    else if (only.item?.status === "pending") holdSub = "PayPal is still working on this.";
    else holdSub = `This stopped at ${only.item?.errorCode ?? "an unknown step"}.`;
  }

  return {
    eyebrow: "Bidding closed",
    title: `${settlement?.winnersSettled ?? 0} charged, ${open.length} not settled`,
    holdLine: only
      ? `Paddle ${formatPaddleNumber(only.paddleNumber)} · ${only.bidder} · ${formatUsd(only.toChargeCents)}`
      : `${open.length} bidders are not settled`,
    holdSub,
    left: { cents: settlement?.chargedCents ?? 0, label: "charged" },
    right: { cents: owedCents, label: "not charged yet" },
    caption: [
      only ? `${only.bidder}’s ${formatUsd(only.heldCents)} hold stays until this goes through.` : "Their holds stay until these go through.",
      declined ? "A declined charge moves no money, so you can retry." : "Retrying can’t charge anyone twice.",
    ],
    note: honest,
  };
}

/** The lime button, or null when the phase has no action. */
export interface RailAction {
  label: string;
  enabled: boolean;
  kind: "charge" | "retry" | "none";
}

export function railAction(view: LedgerView, checks: SettlementChecks, busy: boolean): RailAction | null {
  switch (view.phase) {
    case "live":
      return { label: "Charge winners", enabled: false, kind: "none" };
    case "ready":
      return {
        label: `Charge ${plural(view.counts.winners, "winner")}`,
        enabled: checks.passed === true && !busy,
        kind: "charge",
      };
    case "charging":
      return { label: "Charging…", enabled: false, kind: "none" };
    case "failed": {
      const open = view.rows.filter((row) => canRetry(row.item));
      if (open.every((row) => row.item?.status === "pending")) return { label: "Ask PayPal again", enabled: !busy, kind: "retry" };
      const noun = open.every((row) => row.item?.action === "capture") ? "charge" : "item";
      return { label: `Retry ${plural(open.length, `failed ${noun}`)}`, enabled: !busy, kind: "retry" };
    }
    case "charged":
    case "ended":
      return null;
  }
}

// Checks ---------------------------------------------------------------------------------------------

export type CheckMark = "passed" | "failed" | "unknown";

export interface CheckRow {
  key: CheckKey;
  mark: CheckMark;
  label: string;
  /** What to look at, on a failed check: "Paddle 142 · Jamie K. · VOIDED". */
  details: string[];
}

/** The checks' own codes in words; anything else is PayPal's status or issue, as PayPal wrote it. */
const PROBLEM_WORDS: Readonly<Record<string, string>> = {
  no_hold: "no hold in place",
  over_hold: "over their hold",
  over_limit: "past its limit",
  no_limit: "no limit on record",
  over_authorization: "more than PayPal authorized",
  no_authorization: "no PayPal authorization",
};

function problemLine(problem: CheckProblem): string {
  const why = PROBLEM_WORDS[problem.code] ?? `PayPal says ${problem.code}`;
  return `Paddle ${formatPaddleNumber(problem.paddleNumber)} · ${problem.bidder} · ${why}`;
}

function checkLabel(key: CheckKey, count: number, failures: number, view: LedgerView): string {
  const honest = view.event.isDemo || view.holds.real > 0;
  switch (key) {
    case "winners_within_holds":
      return failures > 0 ? `${plural(failures, "winner")} over their hold` : "Every winner’s total is within their hold";
    case "glim_within_limits":
      if (failures > 0) return `${plural(failures, "bidder")} with a Glim bid past a limit`;
      if (view.phase === "live") return "All of Glim’s bids stayed within their limits";
      return count === 0 ? "Glim placed no bids" : `All ${count} of Glim’s bids stayed within their limits`;
    case "holds_valid":
      if (failures > 0) return `${plural(failures, "PayPal hold")} no longer valid`;
      return honest ? "Every PayPal hold is still valid" : "Every hold is still valid with PayPal";
  }
}

export function checkRows(view: LedgerView, checks: SettlementChecks): CheckRow[] {
  return checks.checks.map((check) => {
    const blocking = check.problems.filter((problem) => problem.blocking);
    return {
      key: check.key,
      mark: check.passed === null ? "unknown" : check.passed ? "passed" : "failed",
      label: checkLabel(check.key, check.count, blocking.length, view),
      details: blocking.map(problemLine),
    };
  });
}

export function checksHeading(phase: LedgerPhase, checks: SettlementChecks, checking: boolean): string {
  if (phase === "live") return "When bidding closes";
  if (checking) return "Checking…";
  if (checks.passed === null) return "Checking…";
  if (checks.passed) return "All passed";
  const failed = checks.checks.filter((check) => check.passed === false).length;
  return `${failed} failed`;
}

export function glimLine(view: Pick<LedgerView, "glim" | "phase">): string | null {
  const { bidders, winners } = view.glim;
  if (bidders === 0) return null;
  const live = view.phase === "live";
  // In a judge's demo the only Glim is the judge's, and "1 of them" reads as a mistake.
  if (bidders === 1) {
    if (winners === 0) return `Glim bid for 1 bidder, who ${live ? "isn’t winning" : "won nothing"}`;
    return `Glim bid for 1 bidder, who ${live ? "is winning" : "won lots"}`;
  }
  return `Glim bid for ${plural(bidders, "bidder")}; ${winners} of them ${live ? "are winning" : "won lots"}`;
}
