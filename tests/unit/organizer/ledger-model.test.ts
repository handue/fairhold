import { describe, expect, it } from "vitest";

import type { LedgerRow, LedgerView, SettlementChecks } from "@/server/settlement/types";
import {
  canRetry,
  checkRows,
  checksHeading,
  csvSafe,
  diffLedgerRows,
  filterLabels,
  filterPasses,
  glimLine,
  holdKindLabel,
  itemStatusLabel,
  lotsColumnHeader,
  lotsTotalLabel,
  railAction,
  railCopy,
  rowStatusClass,
  withoutBidsLine,
} from "@/ui/organizer/ledger-model";

const passed: SettlementChecks = {
  passed: true,
  ranAt: null,
  checks: [
    { key: "winners_within_holds", passed: true, count: 19, problems: [] },
    { key: "glim_within_limits", passed: true, count: 96, problems: [] },
    { key: "holds_valid", passed: true, count: 0, problems: [] },
  ],
};

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    paddleId: "p142",
    paddleNumber: 142,
    bidder: "Jamie K.",
    lotsWon: "Chef’s Table, Spa Day",
    lotsWonFull: "Chef’s Table Dinner for Four, Spa Day for Two",
    glim: true,
    holdKind: "simulated",
    heldCents: 50_000,
    toChargeCents: 47_000,
    toReleaseCents: 3_000,
    item: null,
    ...overrides,
  };
}

function view(overrides: Partial<LedgerView> = {}): LedgerView {
  return {
    event: {
      slug: "riverside-shelter-gala",
      name: "Riverside Shelter Gala",
      charityName: "Riverside Animal Shelter",
      timeZone: "America/Los_Angeles",
      status: "closed",
      opensAt: Date.parse("2026-11-08T03:00:00Z"),
      closesAt: Date.parse("2026-11-08T05:30:00Z"),
      isDemo: false,
      dateLabel: "Saturday, November 7, 2026",
    },
    phase: "ready",
    rows: [row()],
    counts: { all: 86, winners: 19, nonWinners: 67 },
    totals: { heldCents: 4_395_000, toChargeCents: 816_000, toReleaseCents: 3_579_000 },
    lots: { total: 24, closed: 24, sold: 23, withoutBids: [{ number: 22, title: "Golf Lesson with a Pro" }] },
    holds: { real: 0, simulated: 86 },
    glim: { bidders: 31, winners: 9, bids: 96 },
    checks: passed,
    settlement: null,
    ...overrides,
  };
}

const demo = (overrides: Partial<LedgerView> = {}) =>
  view({ event: { ...view().event, isDemo: true }, holds: { real: 1, simulated: 85 }, ...overrides });

const settlement = (overrides: Partial<NonNullable<LedgerView["settlement"]>> = {}) => ({
  id: "s1",
  status: "running" as const,
  startedAt: 1,
  finishedAt: null,
  winners: 19,
  winnersSettled: 7,
  chargedCents: 477_000,
  releasedCents: 0,
  failed: 0,
  pending: 0,
  active: 12,
  ...overrides,
});

describe("the approved 12", () => {
  it("says exactly what the mockup says", () => {
    expect(railCopy(view())).toEqual({
      eyebrow: "Bidding closed",
      title: "Ready to charge",
      holdLine: "$43,950 held with PayPal · 86 bidders",
      holdSub: "Nothing has been charged yet.",
      left: { cents: 816_000, label: "to charge" },
      right: { cents: 3_579_000, label: "to release" },
      caption: ["One charge per winner, for the lots they won.", "The rest of their hold is released at the same time."],
      note: "Bidders who won nothing have their whole hold released.",
    });
    expect(railAction(view(), passed, false)).toEqual({ label: "Charge 19 winners", enabled: true, kind: "charge" });
    expect(checksHeading("ready", passed, false)).toBe("All passed");
    expect(checkRows(view(), passed).map((check) => check.label)).toEqual([
      "Every winner’s total is within their hold",
      "All 96 of Glim’s bids stayed within their limits",
      "Every hold is still valid with PayPal",
    ]);
    expect(glimLine(view())).toBe("Glim bid for 31 bidders; 9 of them won lots");
    expect(withoutBidsLine(view())).toBe("Lot 22, Golf Lesson with a Pro, had no bids");
    expect(lotsTotalLabel(view())).toBe("23 of 24 lots sold");
    expect(filterLabels("ready")).toEqual({ all: "All", winners: "Winners", nothing: "Won nothing" });
    expect(lotsColumnHeader("ready")).toBe("Lots won");
  });
});

describe("honest labels in a demo", () => {
  it("does not call simulated holds PayPal holds", () => {
    const copy = railCopy(demo());
    expect(copy.holdLine).toBe("$43,950 held · 86 bidders");
    expect(copy.holdSub).toBe("The 85 simulated guests settle without PayPal.");
    expect(checkRows(demo(), passed).find((check) => check.key === "holds_valid")?.label).toBe("Every PayPal hold is still valid");
  });

  it("uses the past tense once they have, and the singular for one", () => {
    const charged = demo({ phase: "charged", settlement: settlement({ status: "done", winnersSettled: 19, chargedCents: 816_000, releasedCents: 3_579_000, active: 0 }) });
    expect(railCopy(charged).holdSub).toBe("The 85 simulated guests settled without PayPal.");
    expect(railCopy(demo({ holds: { real: 1, simulated: 1 } })).holdSub).toBe("The simulated guest settles without PayPal.");
  });

  it("labels every row in the CSV", () => {
    expect(holdKindLabel({ holdKind: "paypal" })).toBe("PayPal");
    expect(holdKindLabel({ holdKind: "simulated" })).toBe("Simulated, no PayPal");
    expect(holdKindLabel({ holdKind: null })).toBe("");
  });

  it("never uses a word the brand rules forbid, in any phase", () => {
    const phases = [
      view({ phase: "live" }),
      view(),
      demo({ phase: "charging", settlement: settlement() }),
      demo({ phase: "charged", settlement: settlement({ status: "done" }) }),
      demo({
        phase: "failed",
        rows: [row({ item: { id: "i", action: "capture", status: "failed", paypalCaptureId: null, errorCode: "INSTRUMENT_DECLINED" } })],
        settlement: settlement({ status: "done_with_errors", failed: 1, active: 0 }),
      }),
    ];
    for (const phase of phases) {
      const text = JSON.stringify(railCopy(phase)).toLowerCase();
      expect(text).not.toMatch(/\bfmv\b|\birs\b|guarantee|tax/);
    }
  });
});

describe("the rail's other phases", () => {
  it("while bidding runs: would-charge figures, nothing clickable", () => {
    const live = view({ phase: "live", event: { ...view().event, status: "live" } });
    expect(railCopy(live)).toMatchObject({
      eyebrow: "Bidding open",
      title: "Closes at 9:30 PM",
      left: { label: "to charge" },
      caption: ["If bidding ended now, 19 winners would be charged.", "Nothing is charged while bidding is open."],
    });
    expect(railAction(live, passed, false)).toEqual({ label: "Charge winners", enabled: false, kind: "none" });
    expect(checksHeading("live", passed, false)).toBe("When bidding closes");
    expect(glimLine({ glim: { bidders: 29, winners: 9, bids: 84 }, phase: "live" })).toBe("Glim bid for 29 bidders; 9 of them are winning");
    expect(glimLine({ glim: { bidders: 1, winners: 1, bids: 2 }, phase: "live" })).toBe("Glim bid for 1 bidder, who is winning");
    expect(glimLine({ glim: { bidders: 1, winners: 0, bids: 2 }, phase: "live" })).toBe("Glim bid for 1 bidder, who isn’t winning");
    expect(glimLine({ glim: { bidders: 1, winners: 1, bids: 2 }, phase: "ready" })).toBe("Glim bid for 1 bidder, who won lots");
    expect(glimLine({ glim: { bidders: 1, winners: 0, bids: 2 }, phase: "ready" })).toBe("Glim bid for 1 bidder, who won nothing");
    expect(lotsColumnHeader("live")).toBe("Winning now");
    expect(lotsTotalLabel({ lots: { total: 24, closed: 4, sold: 4, withoutBids: [] }, phase: "live" })).toBe("4 of 24 lots closed");
    expect(withoutBidsLine({ lots: { total: 24, closed: 4, sold: 4, withoutBids: [{ number: 22, title: "Golf" }] }, phase: "live" })).toBe("Lot 22, Golf, has no bids yet");
    expect(filterLabels("live")).toEqual({ all: "All", winners: "Winning", nothing: "Not winning" });
  });

  it("charging: progress, and no second click", () => {
    const charging = view({ phase: "charging", settlement: settlement() });
    expect(railCopy(charging)).toMatchObject({
      title: "Charging 7 of 19",
      left: { cents: 477_000, label: "charged so far" },
      right: { cents: 339_000, label: "still to charge" },
      note: "You can leave this page. Charging keeps going.",
    });
    expect(railAction(charging, passed, false)).toEqual({ label: "Charging…", enabled: false, kind: "none" });
  });

  it("charged: what was charged and released, and no action left", () => {
    const charged = view({ phase: "charged", settlement: settlement({ status: "done", winnersSettled: 19, chargedCents: 816_000, releasedCents: 3_579_000, active: 0 }) });
    expect(railCopy(charged)).toMatchObject({
      title: "19 winners charged",
      holdLine: "Every hold is settled · 86 bidders",
      left: { cents: 816_000, label: "charged" },
      right: { cents: 3_579_000, label: "released" },
    });
    expect(railAction(charged, passed, false)).toBeNull();
    expect(railCopy({ ...charged, settlement: settlement({ status: "done", winners: 1, winnersSettled: 1 }) }).title).toBe("1 winner charged");
  });

  it("failed: names the row, says what the hold does, and offers the retry", () => {
    const failed = view({
      phase: "failed",
      rows: [
        row({ item: { id: "i", action: "capture", status: "failed", paypalCaptureId: null, errorCode: "INSTRUMENT_DECLINED" } }),
        row({ paddleId: "p175", paddleNumber: 175, item: { id: "j", action: "simulate", status: "succeeded", paypalCaptureId: null, errorCode: null } }),
      ],
      settlement: settlement({ status: "done_with_errors", winnersSettled: 18, chargedCents: 769_000, failed: 1, active: 0 }),
    });
    expect(railCopy(failed)).toMatchObject({
      title: "18 charged, 1 not settled",
      holdLine: "Paddle 142 · Jamie K. · $470",
      holdSub: "PayPal declined this charge.",
      right: { cents: 47_000, label: "not charged yet" },
      caption: ["Jamie K.’s $500 hold stays until this goes through.", "A declined charge moves no money, so you can retry."],
    });
    expect(railAction(failed, passed, false)).toEqual({ label: "Retry 1 failed charge", enabled: true, kind: "retry" });
    expect(railAction(failed, passed, true)).toMatchObject({ enabled: false });
  });

  it("failed with several rows, and a failed release", () => {
    const rows = [
      row({ item: { id: "i", action: "capture", status: "failed", paypalCaptureId: null, errorCode: "X" } }),
      row({ paddleId: "p2", toChargeCents: 0, item: { id: "j", action: "void", status: "failed", paypalCaptureId: null, errorCode: "Y" } }),
    ];
    const failed = view({ phase: "failed", rows, settlement: settlement({ status: "done_with_errors", failed: 2, active: 0 }) });
    expect(railCopy(failed).holdLine).toBe("2 bidders are not settled");
    expect(railAction(failed, passed, false)?.label).toBe("Retry 2 failed items");
  });

  it("a demo retired before anyone charged it: says so, and offers nothing", () => {
    const ended = demo({ phase: "ended" });
    expect(railCopy(ended)).toMatchObject({ title: "This event has ended", left: { cents: 0, label: "charged" }, right: { label: "released" } });
    expect(railAction(ended, passed, false)).toBeNull();
  });

  it("a failure that is not a decline says where it stopped, and does not claim one", () => {
    const stopped = view({
      phase: "failed",
      rows: [row({ item: { id: "i", action: "capture", status: "failed", paypalCaptureId: null, errorCode: "HOLD_VOIDED" } })],
      settlement: settlement({ status: "done_with_errors", failed: 1, active: 0 }),
    });
    expect(railCopy(stopped).holdSub).toBe("This stopped at HOLD_VOIDED.");
    expect(railCopy(stopped).caption[1]).toBe("Retrying can’t charge anyone twice.");
  });

  it("a row waiting on PayPal does not claim a decline", () => {
    const waiting = view({
      phase: "failed",
      rows: [row({ item: { id: "i", action: "capture", status: "pending", paypalCaptureId: "C", errorCode: null } })],
      settlement: settlement({ status: "done_with_errors", pending: 1, active: 0 }),
    });
    expect(railCopy(waiting).caption[1]).toBe("Retrying can’t charge anyone twice.");
    expect(railCopy(waiting).holdSub).toBe("PayPal is still working on this.");
    expect(railAction(waiting, passed, false)).toEqual({ label: "Ask PayPal again", enabled: true, kind: "retry" });
  });
});

describe("checks on the rail", () => {
  const failing: SettlementChecks = {
    passed: false,
    ranAt: 1,
    checks: [
      { key: "winners_within_holds", passed: true, count: 19, problems: [] },
      { key: "glim_within_limits", passed: true, count: 96, problems: [] },
      {
        key: "holds_valid",
        passed: false,
        count: 1,
        problems: [
          { paddleNumber: 142, bidder: "Jamie K.", code: "VOIDED", blocking: true },
          { paddleNumber: 143, bidder: "Kai", code: "VOIDED", blocking: false },
        ],
      },
    ],
  };

  it("keeps the charge off and names what failed", () => {
    const rows = checkRows(demo(), failing);
    expect(rows[2]).toEqual({
      key: "holds_valid",
      mark: "failed",
      label: "1 PayPal hold no longer valid",
      details: ["Paddle 142 · Jamie K. · PayPal says VOIDED"],
    });
    expect(checksHeading("ready", failing, false)).toBe("1 failed");
    expect(railAction(demo(), failing, false)).toMatchObject({ enabled: false });
    expect(railCopy(demo({ checks: failing })).title).toBe("Can’t charge yet");
  });

  it("puts the checks' own codes in words", () => {
    const over: SettlementChecks = {
      passed: false,
      ranAt: null,
      checks: [
        {
          key: "winners_within_holds",
          passed: false,
          count: 2,
          problems: [
            { paddleNumber: 88, bidder: "Harold B.", code: "over_hold", blocking: true },
            { paddleNumber: 142, bidder: "Sam", code: "no_hold", blocking: true },
          ],
        },
      ],
    };
    expect(checkRows(view(), over)[0]).toMatchObject({
      label: "2 winners over their hold",
      details: ["Paddle 088 · Harold B. · over their hold", "Paddle 142 · Sam · no hold in place"],
    });
  });

  it("waits while PayPal is being asked, with the charge off", () => {
    const undecided: SettlementChecks = { passed: null, ranAt: null, checks: passed.checks.map((check) => ({ ...check, passed: check.key === "holds_valid" ? null : true })) };
    expect(checkRows(demo(), undecided)[2]?.mark).toBe("unknown");
    expect(checksHeading("ready", undecided, false)).toBe("Checking…");
    expect(checksHeading("ready", passed, true)).toBe("Checking…");
    expect(railAction(demo(), undecided, false)).toMatchObject({ enabled: false });
    expect(railAction(demo(), passed, true)).toMatchObject({ enabled: false });
  });

  it("says so when Glim placed no bids", () => {
    const none = { ...passed, checks: passed.checks.map((check) => (check.key === "glim_within_limits" ? { ...check, count: 0 } : check)) };
    expect(checkRows(view(), none)[1]?.label).toBe("Glim placed no bids");
    expect(glimLine({ glim: { bidders: 0, winners: 0, bids: 0 }, phase: "ready" })).toBeNull();
  });
});

describe("row status", () => {
  it("only says Charging or Charged of a real hold", () => {
    const item = (action: "capture" | "void" | "simulate", status: "queued" | "processing" | "succeeded" | "pending" | "failed") => ({
      id: "i",
      action,
      status,
      paypalCaptureId: null,
      errorCode: null,
    });
    expect(itemStatusLabel(item("capture", "queued"))).toBe("Queued");
    expect(itemStatusLabel(item("capture", "processing"))).toBe("Charging…");
    expect(itemStatusLabel(item("capture", "succeeded"))).toBe("Charged");
    expect(itemStatusLabel(item("capture", "pending"))).toBe("Waiting on PayPal");
    expect(itemStatusLabel(item("capture", "failed"))).toBe("Failed");
    expect(itemStatusLabel(item("void", "processing"))).toBe("Releasing…");
    expect(itemStatusLabel(item("void", "succeeded"))).toBe("Released");
    expect(itemStatusLabel(item("simulate", "processing"))).toBe("Settling…");
    expect(itemStatusLabel(item("simulate", "succeeded"))).toBe("Simulated");

    expect(canRetry(item("capture", "failed"))).toBe(true);
    expect(canRetry(item("capture", "pending"))).toBe(true);
    expect(canRetry(item("capture", "succeeded"))).toBe(false);
    expect(canRetry(null)).toBe(false);

    expect(rowStatusClass(null)).toBeNull();
    expect(rowStatusClass(item("capture", "processing"))).toBe("charging");
    expect(rowStatusClass(item("capture", "succeeded"))).toBe("charged");
    expect(rowStatusClass(item("capture", "failed"))).toBe("failed");
    expect(rowStatusClass(item("capture", "queued"))).toBeNull();
  });
});

describe("the grid's filter and transactions", () => {
  it("filters by what a row charges", () => {
    expect(filterPasses("all", { toChargeCents: 0 })).toBe(true);
    expect(filterPasses("winners", { toChargeCents: 1 })).toBe(true);
    expect(filterPasses("winners", { toChargeCents: 0 })).toBe(false);
    expect(filterPasses("nothing", { toChargeCents: 0 })).toBe(true);
    expect(filterPasses("nothing", { toChargeCents: 1 })).toBe(false);
  });

  it("touches only the rows that changed", () => {
    const same = row({ paddleId: "same" });
    const moved = row({ paddleId: "moved", toChargeCents: 1_000 });
    const gone = row({ paddleId: "gone" });
    const added = row({ paddleId: "added" });
    const movedNow = { ...moved, toChargeCents: 2_000 };

    const changes = diffLedgerRows([same, moved, gone], [{ ...same }, movedNow, added]);

    expect(changes).toEqual({ add: [added], update: [movedNow], remove: [gone] });
    expect(diffLedgerRows([same], [{ ...same }])).toEqual({ add: [], update: [], remove: [] });
  });
});

describe("csvSafe", () => {
  it("disarms what a spreadsheet would run as a formula", () => {
    for (const formula of ['=HYPERLINK("http://evil.example")', "+1+1", "-2+3", "@SUM(A1)", "\tx", "\rx"]) {
      expect(csvSafe(formula)).toBe(`'${formula}`);
    }
  });

  it("leaves everything else alone", () => {
    for (const plain of ["Jamie K.", "$1,450", "Chef’s Table, Spa Day", "142", ""]) {
      expect(csvSafe(plain)).toBe(plain);
    }
  });
});
