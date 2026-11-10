/**
 * What the control room says, decided here with no React and no grid, so it can be tested on its own.
 * "Ready to charge" is the approved 12; every other state is design/24, value for value.
 */
import { paypalIdOrNull } from "@/server/paypal/simulated-ids";
import type { Instant } from "@/server/queries/types";
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

/**
 * How the Status cell draws a row (design/24 §2–§4 and §6): a simulated guest settles in the database
 * and says Simulated; only a real hold says Charging…, Charged or Released, so real rows stand out.
 */
export type StatusTone = "simulated" | "queued" | "working" | "charged" | "released" | "failed" | "waiting";

export function itemStatusTone(item: LedgerItem): StatusTone {
  if (item.status === "failed") return "failed";
  if (item.status === "pending") return "waiting";
  if (item.status === "queued") return "queued";
  if (item.status === "processing") return "working";
  if (item.action === "simulate") return "simulated";
  return item.action === "capture" ? "charged" : "released";
}

/** The Status cell's words, which the CSV and the search read too. */
export function itemStatusLabel(item: LedgerItem): string {
  switch (itemStatusTone(item)) {
    case "failed":
      return "Failed";
    case "waiting":
      return "Waiting on PayPal";
    case "queued":
      return "Queued";
    case "working":
      if (item.action === "simulate") return "Settling…";
      return item.action === "capture" ? "Charging…" : "Releasing…";
    case "simulated":
      return "Simulated";
    case "charged":
      return "Charged";
    case "released":
      return "Released";
  }
}

/** The pill in a row that needs the organizer, and the button beside it. */
export function rowActionLabels(item: LedgerItem): { pill: string; button: string } | null {
  if (item.status === "failed") return { pill: "Failed", button: "Retry" };
  if (item.status === "pending") return { pill: "Waiting", button: "Ask again" };
  return null;
}

export function canRetry(item: LedgerItem | null): boolean {
  return item?.status === "failed" || item?.status === "pending";
}

/** A row class for the grid's rowClassRules. */
export function rowStatusClass(item: LedgerItem | null): "charging" | "charged" | "failed" | null {
  if (!item) return null;
  if (item.status === "failed" || item.status === "pending") return "failed";
  if (item.status === "succeeded") return "charged";
  return item.status === "processing" ? "charging" : null;
}

/**
 * Before charging, the rows a failed check names (design/24 §5): the row turns Surface and the pill
 * stands where its hold was. Only problems that stop the charge mark a row.
 */
export function flaggedPaddles(checks: SettlementChecks): Map<number, string> {
  const flagged = new Map<number, string>();
  for (const check of checks.checks) {
    for (const problem of check.problems) {
      if (!problem.blocking || flagged.has(problem.paddleNumber)) continue;
      flagged.set(problem.paddleNumber, flagLabel(check.key, problem.code));
    }
  }
  return flagged;
}

function flagLabel(key: CheckKey, code: string): string {
  if (key === "holds_valid") return "Not valid";
  if (code === "no_hold") return "No hold";
  if (code === "over_hold") return "Over hold";
  return "Check";
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

/** The round mark beside the hold row: 12's lock, a check once everything settled, "!" for a failed row. */
export type RailMark = "lock" | "check" | "alert";

export interface RailCopy {
  eyebrow: string;
  title: string;
  /** While bidding runs the title counts down to this instant: "Closes in 14:20". */
  countdownTo: Instant | null;
  /** The title's figures in Geist Mono, as in "Charging 7 of 19". */
  monoFigures: boolean;
  mark: RailMark;
  holdLine: string;
  holdSub: string;
  left: RailFigure;
  right: RailFigure;
  /** 09's split: lime for what goes back to the bidders, a quiet track for what is still to happen. */
  bar: "released" | "remaining";
  caption: [string, string];
  note: string | null;
}

/**
 * A demo mixes real holds with simulated guests, so "held with PayPal" would not be true of them
 * (design/24 §6). Counted from the event: with 3 real holds it reads "The 83 simulated guests…". A
 * screen with only real holds, or the seeded fixture's, keeps 12's approved wording.
 */
function simulatedLine(view: LedgerView, verb: "settle" | "settled"): string | null {
  const { real, simulated } = view.holds;
  if (simulated === 0 || (!view.event.isDemo && real === 0)) return null;
  const without = verb === "settled" ? "settled" : simulated === 1 ? "settles" : "settle";
  return `The ${simulated === 1 ? "" : `${simulated} `}simulated ${simulated === 1 ? "guest" : "guests"} ${without} without PayPal.`;
}

const ONE_CHARGE: [string, string] = ["One charge per winner, for the lots they won.", "The rest of their hold is released at the same time."];

export function railCopy(view: LedgerView): RailCopy {
  const { heldCents, toChargeCents, toReleaseCents } = view.totals;
  const bidders = plural(view.counts.all, "bidder");
  const honest = simulatedLine(view, "settle");
  const heldLine = honest ? `${formatUsd(heldCents)} held · ${bidders}` : `${formatUsd(heldCents)} held with PayPal · ${bidders}`;
  const settlement = view.settlement;
  const base = { countdownTo: null, monoFigures: false, mark: "lock" as const, bar: "released" as const };

  switch (view.phase) {
    case "live":
      return {
        ...base,
        eyebrow: "Bidding open",
        title: "Closes in",
        countdownTo: view.event.closesAt,
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
        ...base,
        eyebrow: "Bidding closed",
        title: view.checks.passed === false ? "Can’t charge yet" : "Ready to charge",
        holdLine: heldLine,
        holdSub: honest ?? "Nothing has been charged yet.",
        left: { cents: toChargeCents, label: "to charge" },
        right: { cents: toReleaseCents, label: "to release" },
        caption: ONE_CHARGE,
        note: "Bidders who won nothing have their whole hold released.",
      };
    case "charging": {
      const charged = settlement?.chargedCents ?? 0;
      return {
        ...base,
        eyebrow: "Bidding closed",
        title: `Charging ${settlement?.winnersSettled ?? 0} of ${settlement?.winners ?? view.counts.winners}`,
        monoFigures: true,
        holdLine: heldLine,
        holdSub: honest ?? "Winners are being charged now.",
        left: { cents: charged, label: "charged so far" },
        right: { cents: Math.max(0, toChargeCents - charged), label: "still to charge" },
        bar: "remaining",
        caption: ONE_CHARGE,
        note: "You can leave this page. Charging keeps going.",
      };
    }
    case "charged":
      return {
        ...base,
        eyebrow: "Bidding closed",
        title: `${plural(settlement?.winners ?? view.counts.winners, "winner")} charged`,
        mark: "check",
        holdLine: `Every hold is settled · ${bidders}`,
        holdSub: simulatedLine(view, "settled") ?? "Nothing more is held for this event.",
        left: { cents: settlement?.chargedCents ?? toChargeCents, label: "charged" },
        right: { cents: settlement?.releasedCents ?? toReleaseCents, label: "released" },
        caption: ["One charge per winner, for the lots they won.", "The rest of their hold was released at the same time."],
        note: "Bidders who won nothing had their whole hold released.",
      };
    case "failed":
      return failedCopy(view);
    case "ended":
      return {
        ...base,
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

const openRows = (view: Pick<LedgerView, "rows">) => view.rows.filter((row) => canRetry(row.item));

/** "18 charged, 1 failed", and "1 waiting" for a row PayPal has not finished. */
function failedTitle(view: LedgerView): string {
  const open = openRows(view);
  const failed = open.filter((row) => row.item?.status === "failed").length;
  const waiting = open.length - failed;
  const parts = [`${view.settlement?.winnersSettled ?? 0} charged`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.join(", ");
}

function failedCopy(view: LedgerView): RailCopy {
  const settlement = view.settlement;
  const open = openRows(view);
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
    title: failedTitle(view),
    countdownTo: null,
    monoFigures: false,
    mark: "alert",
    holdLine: only
      ? `Paddle ${formatPaddleNumber(only.paddleNumber)} · ${only.bidder} · ${formatUsd(only.toChargeCents)}`
      : `${open.length} bidders are not settled`,
    holdSub,
    left: { cents: settlement?.chargedCents ?? 0, label: "charged" },
    right: { cents: owedCents, label: "not charged yet" },
    bar: "remaining",
    caption: [
      only ? `${only.bidder}’s ${formatUsd(only.heldCents)} hold stays until this goes through.` : "Their holds stay until these go through.",
      declined
        ? "A declined charge moves no money, so you can retry."
        : open.every((row) => row.item?.status === "pending")
          ? "Asking again can’t charge anyone twice."
          : "Retrying can’t charge anyone twice.",
    ],
    note: simulatedLine(view, "settled"),
  };
}

// Checks ---------------------------------------------------------------------------------------------

/** Where the page is with asking PayPal (see checks-request.ts). */
export type ChecksRequest = "idle" | "asking" | "failed";

export type CheckMark = "passed" | "failed" | "pending";

export interface CheckRow {
  key: CheckKey | "glim_rules" | "released" | "receipts";
  mark: CheckMark;
  label: string;
  /** Under the words, in 12's note type: what to look at, or what was counted. */
  details: string[];
}

/** A failed check names the hold in a sentence: "Paddle 142 · Jamie K. PayPal shows it as voided." */
const PROBLEM_SENTENCES: Readonly<Record<string, string>> = {
  no_hold: "There is no hold in place.",
  over_hold: "Their total is over their hold.",
  over_limit: "A Glim bid went past its limit.",
  no_limit: "A Glim bid has no limit on record.",
  over_authorization: "PayPal authorized less than their total.",
  no_authorization: "There is no PayPal authorization on record.",
  VOIDED: "PayPal shows it as voided.",
  EXPIRED: "PayPal shows it as expired.",
  CAPTURED: "PayPal shows it as captured.",
  PARTIALLY_CAPTURED: "PayPal shows it as partly captured.",
  DENIED: "PayPal shows it as denied.",
  PENDING: "PayPal shows it as pending.",
  INVALID_RESOURCE_ID: "PayPal has no record of it.",
  RESOURCE_NOT_FOUND: "PayPal has no record of it.",
};

/** A failed check shows at most this many paddles; the ledger marks every row it names. */
const MAX_PROBLEM_LINES = 2;

export function problemLine(problem: CheckProblem): string {
  const sentence = PROBLEM_SENTENCES[problem.code] ?? `PayPal answered ${problem.code}.`;
  const name = problem.bidder.endsWith(".") ? problem.bidder : `${problem.bidder}.`;
  return `Paddle ${formatPaddleNumber(problem.paddleNumber)} · ${name} ${sentence}`;
}

function problemLines(problems: readonly CheckProblem[]): string[] {
  const lines = problems.slice(0, MAX_PROBLEM_LINES).map(problemLine);
  const more = problems.length - MAX_PROBLEM_LINES;
  if (more > 0) lines.push(`And ${more} more, marked in the ledger.`);
  return lines;
}

function checkLabel(key: CheckKey, count: number, failures: number, view: LedgerView): string {
  const honest = view.event.isDemo || view.holds.real > 0;
  switch (key) {
    case "winners_within_holds":
      if (failures === 1) return "1 winner is over their hold";
      return failures > 1 ? `${failures} winners are over their holds` : "Every winner’s total is within their hold";
    case "glim_within_limits":
      if (failures === 1) return "1 bidder has a Glim bid past a limit";
      if (failures > 1) return `${failures} bidders have a Glim bid past a limit`;
      if (view.phase === "live") return "All of Glim’s bids stayed within their limits";
      return count === 0 ? "Glim placed no bids" : `All ${count} of Glim’s bids stayed within their limits`;
    case "holds_valid":
      if (failures === 1) return "1 PayPal hold is no longer valid";
      if (failures > 1) return `${failures} PayPal holds are no longer valid`;
      return honest ? "Every PayPal hold is still valid" : "Every hold is still valid with PayPal";
  }
}

/** 21's V6 row, under the bids check, once Glim has decided anything on its own. */
function glimRulesRow(view: LedgerView): CheckRow | null {
  const { decisions, decisionsOutsideRules: outside } = view.glim;
  if (decisions === 0) return null;
  if (outside > 0) {
    return {
      key: "glim_rules",
      mark: "failed",
      label: `${plural(outside, "decision")} outside a guest’s rules`,
      details: [`${plural(decisions, "decision")} in all`],
    };
  }
  return {
    key: "glim_rules",
    mark: "passed",
    label: "Glim stayed inside every guest’s rules",
    details: [decisions === 1 ? "1 decision · inside the rules" : `${decisions} decisions · all inside the rules`],
  };
}

export function checkRows(view: LedgerView, checks: SettlementChecks): CheckRow[] {
  const rows: CheckRow[] = [];
  for (const check of checks.checks) {
    const blocking = check.problems.filter((problem) => problem.blocking);
    const live = view.phase === "live";
    rows.push({
      key: check.key,
      mark: live || check.passed === null ? "pending" : check.passed ? "passed" : "failed",
      label: checkLabel(check.key, check.count, live ? 0 : blocking.length, view),
      details: live ? [] : problemLines(blocking),
    });
    if (check.key === "glim_within_limits" && !live) {
      const rules = glimRulesRow(view);
      if (rules) rows.push(rules);
    }
  }
  return rows;
}

export type HeadingTone = "wait" | "ok" | "fail";

/** The section's right-hand word: what the checks came to, or that they wait. */
export function checksHeading(phase: LedgerPhase, checks: SettlementChecks, request: ChecksRequest): { text: string; tone: HeadingTone } {
  if (phase === "live") return { text: "When bidding closes", tone: "wait" };
  if (request === "asking") return { text: "Checking…", tone: "wait" };
  if (checks.passed === null) return { text: request === "failed" ? "Not checked yet" : "Checking…", tone: "wait" };
  if (checks.passed) return { text: "All passed", tone: "ok" };
  const failed = checks.checks.filter((check) => check.passed === false).length;
  return { text: `${failed} failed`, tone: "fail" };
}

export interface RailSection {
  label: string;
  heading: { text: string; tone: HeadingTone };
  rows: CheckRow[];
  /** The Glim line under the rows; a failed check leaves it out to keep the rail's height (§5). */
  glim: string | null;
}

/** The rail's middle section: the checks, or once everything settled, what was done (§3). */
export function railSection(view: LedgerView, checks: SettlementChecks, request: ChecksRequest): RailSection {
  const glim = glimLine(view);
  if (view.phase === "charged") {
    const settlement = view.settlement;
    return {
      label: "Done",
      heading: { text: settlement?.finishedAt ? formatClockTime(settlement.finishedAt, view.event.timeZone) : "", tone: "ok" },
      rows: [
        { key: "released", mark: "passed", label: `${plural(settlement?.releasedInFull ?? 0, "hold")} released in full`, details: [] },
        { key: "receipts", mark: "passed", label: `${plural(settlement?.receipts ?? 0, "receipt")} issued`, details: [] },
      ],
      glim,
    };
  }
  const heading = checksHeading(view.phase, checks, request);
  return {
    label: "Checks",
    heading,
    rows: checkRows(view, checks),
    glim: heading.tone === "fail" ? null : glim,
  };
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

// The rail's foot ------------------------------------------------------------------------------------

export type FootAction = "close" | "check" | "charge" | "retry" | "receipt";

/**
 * The rail's last row, left to right: what you can do now, and what comes next switched off (§1, §5);
 * the one lime button; a job under way in the button's own shape (§2); or nothing.
 */
export type RailFoot =
  | { kind: "pair"; now: { label: string; action: FootAction }; next: string }
  | { kind: "off"; label: string }
  | { kind: "cta"; label: string; action: FootAction; enabled: boolean }
  | { kind: "working"; label: string }
  | { kind: "none" };

export interface FootContext {
  request: ChecksRequest;
  /** A charge, a retry or a close is being sent. */
  busy: boolean;
  /** The organizer's own receipt, in a demo; null hides "See your receipt". */
  receiptHref: string | null;
}

export function railFoot(view: LedgerView, checks: SettlementChecks, context: FootContext): RailFoot {
  const chargeLabel = `Charge ${plural(view.counts.winners, "winner")}`;
  switch (view.phase) {
    case "live":
      return view.event.isDemo
        ? { kind: "pair", now: { label: "Close bidding now", action: "close" }, next: "Charge winners" }
        : { kind: "off", label: "Charge winners" };
    case "ready":
      if (context.request === "asking") return { kind: "off", label: chargeLabel };
      if (checks.passed === true) return { kind: "cta", label: chargeLabel, action: "charge", enabled: !context.busy };
      return { kind: "pair", now: { label: "Check again", action: "check" }, next: chargeLabel };
    case "charging":
      return { kind: "working", label: "Charging…" };
    case "failed": {
      const open = openRows(view);
      if (open.every((row) => row.item?.status === "pending")) {
        return { kind: "cta", label: "Ask PayPal again", action: "retry", enabled: !context.busy };
      }
      const failed = open.filter((row) => row.item?.status === "failed");
      const noun = failed.every((row) => row.item?.action === "capture") ? "charge" : "item";
      return { kind: "cta", label: `Retry ${plural(failed.length, `failed ${noun}`)}`, action: "retry", enabled: !context.busy };
    }
    case "charged":
      return view.event.isDemo && context.receiptHref
        ? { kind: "cta", label: "See your receipt", action: "receipt", enabled: true }
        : { kind: "none" };
    case "ended":
      return { kind: "none" };
  }
}

/**
 * The transaction ID above the button once charged (§3): the organizer's own paddle in a demo, else
 * the largest real charge. Every other one is in the CSV. A charge simulated payments made up reads
 * "Simulated", never a made-up id under PayPal's name.
 */
export function transactionLine(view: LedgerView, ownPaddle: number | null): { paddleNumber: number; captureId: string } | null {
  if (view.phase !== "charged") return null;
  const captured = view.rows.filter((row) => row.item?.action === "capture" && row.item.status === "succeeded" && row.item.paypalCaptureId);
  const row = captured.find((candidate) => candidate.paddleNumber === ownPaddle) ?? captured[0];
  return row?.item?.paypalCaptureId
    ? { paddleNumber: row.paddleNumber, captureId: paypalIdOrNull(row.item.paypalCaptureId) ?? "Simulated" }
    : null;
}

// Glim in the corner ---------------------------------------------------------------------------------

/** As the event's assistant, Glim adds the one thing the page doesn't say; null leaves the orb alone. */
export function cornerBubble(view: LedgerView, checks: SettlementChecks): { title: string; body: string } | null {
  switch (view.phase) {
    case "live": {
      const { bidders, bids, bidsOutsideLimits } = view.glim;
      if (bidders === 0) return null;
      const within = bids === 1 ? "1 bid, within its limit." : `${bids} bids, all within their limits.`;
      return { title: `I’m bidding for ${plural(bidders, "guest")}`, body: bidsOutsideLimits === 0 ? within : `${plural(bids, "bid")} so far.` };
    }
    case "ready":
      return checks.passed === false ? null : { title: "Receipts are ready", body: "Every winner gets one when\u00a0you\u00a0charge." };
    case "charged":
      return { title: "Receipts are out", body: "Every winner has one." };
    case "failed": {
      const waiting = openRows(view).filter((row) => row.toChargeCents > 0).length;
      if (waiting === 0) return null;
      return waiting === 1
        ? { title: "1 receipt is waiting", body: "It goes out when this charge goes through." }
        : { title: `${waiting} receipts are waiting`, body: "They go out when these charges go through." };
    }
    case "charging":
    case "ended":
      return null;
  }
}
