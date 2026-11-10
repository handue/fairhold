import { describe, expect, it } from "vitest";

import type { LedgerGlim, LedgerRow, LedgerView, SettlementChecks } from "@/server/settlement/types";
import {
  canRetry,
  checkRows,
  checksHeading,
  cornerBubble,
  csvSafe,
  diffLedgerRows,
  filterLabels,
  filterPasses,
  flaggedPaddles,
  glimLine,
  holdKindLabel,
  itemStatusLabel,
  itemStatusTone,
  lotsColumnHeader,
  lotsTotalLabel,
  problemLine,
  railCopy,
  railFoot,
  railSection,
  rowActionLabels,
  rowStatusClass,
  transactionLine,
  withoutBidsLine,
  type FootContext,
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
    glim: glim(),
    checks: passed,
    settlement: null,
    now: Date.parse("2026-11-08T05:15:40Z"),
    ...overrides,
  };
}

function glim(overrides: Partial<LedgerGlim> = {}): LedgerGlim {
  return { bidders: 31, winners: 9, bids: 96, bidsOutsideLimits: 0, decisions: 0, decisionsOutsideRules: 0, ...overrides };
}

const idle: FootContext = { request: "idle", busy: false, receiptHref: null };

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
  releasedInFull: 0,
  receipts: 0,
  ...overrides,
});

describe("the approved 12", () => {
  it("says exactly what the mockup says", () => {
    expect(railCopy(view())).toEqual({
      eyebrow: "Bidding closed",
      title: "Ready to charge",
      countdownTo: null,
      monoFigures: false,
      mark: "lock",
      holdLine: "$43,950 held with PayPal · 86 bidders",
      holdSub: "Nothing has been charged yet.",
      left: { cents: 816_000, label: "to charge" },
      right: { cents: 3_579_000, label: "to release" },
      bar: "released",
      caption: ["One charge per winner, for the lots they won.", "The rest of their hold is released at the same time."],
      note: "Bidders who won nothing have their whole hold released.",
    });
    expect(railFoot(view(), passed, idle)).toEqual({ kind: "cta", label: "Charge 19 winners", action: "charge", enabled: true });
    expect(railSection(view(), passed, "idle")).toEqual({
      label: "Checks",
      heading: { text: "All passed", tone: "ok" },
      rows: [
        { key: "winners_within_holds", mark: "passed", label: "Every winner’s total is within their hold", details: [] },
        { key: "glim_within_limits", mark: "passed", label: "All 96 of Glim’s bids stayed within their limits", details: [] },
        { key: "holds_valid", mark: "passed", label: "Every hold is still valid with PayPal", details: [] },
      ],
      glim: "Glim bid for 31 bidders; 9 of them won lots",
    });
    expect(cornerBubble(view(), passed)).toEqual({ title: "Receipts are ready", body: "Every winner gets one when you charge." });
    expect(withoutBidsLine(view())).toBe("Lot 22, Golf Lesson with a Pro, had no bids");
    expect(lotsTotalLabel(view())).toBe("23 of 24 lots sold");
    expect(filterLabels("ready")).toEqual({ all: "All", winners: "Winners", nothing: "Won nothing" });
    expect(lotsColumnHeader("ready")).toBe("Lots won");
    expect(flaggedPaddles(passed).size).toBe(0);
  });
});

describe("honest labels in a demo (design/24 §6, C1)", () => {
  it("does not call simulated holds PayPal holds, and asks only about real ones", () => {
    const copy = railCopy(demo());
    expect(copy.holdLine).toBe("$43,950 held · 86 bidders");
    expect(copy.holdSub).toBe("The 85 simulated guests settle without PayPal.");
    expect(checkRows(demo(), passed).find((check) => check.key === "holds_valid")?.label).toBe("Every PayPal hold is still valid");
    // Counted from the event: three real sandbox buyers leave 83 simulated guests.
    expect(railCopy(demo({ holds: { real: 3, simulated: 83 } })).holdSub).toBe("The 83 simulated guests settle without PayPal.");
  });

  it("uses the past tense once they have, and the singular for one", () => {
    const charged = demo({ phase: "charged", settlement: settlement({ status: "done", winnersSettled: 19, chargedCents: 816_000, releasedCents: 3_579_000, active: 0 }) });
    expect(railCopy(charged).holdSub).toBe("The 85 simulated guests settled without PayPal.");
    expect(railCopy(demo({ holds: { real: 1, simulated: 1 } })).holdSub).toBe("The simulated guest settles without PayPal.");
  });

  it("keeps 12's approved lines for an event with only real holds", () => {
    const real = demo({ holds: { real: 86, simulated: 0 } });
    expect(railCopy(real).holdLine).toBe("$43,950 held with PayPal · 86 bidders");
    expect(railCopy(real).holdSub).toBe("Nothing has been charged yet.");
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
      const text = JSON.stringify([railCopy(phase), railSection(phase, passed, "idle"), railFoot(phase, passed, idle), cornerBubble(phase, passed)]).toLowerCase();
      expect(text).not.toMatch(/\bfmv\b|\birs\b|guarantee|tax|fair market/);
    }
  });
});

describe("§1 bidding open", () => {
  const live = demo({ phase: "live", event: { ...demo().event, status: "live" }, glim: glim({ bidders: 29, winners: 9, bids: 84 }) });

  it("counts down to the close, with would-charge figures and the checks waiting", () => {
    expect(railCopy(live)).toMatchObject({
      eyebrow: "Bidding open",
      title: "Closes in",
      countdownTo: live.event.closesAt,
      holdLine: "$43,950 held · 86 bidders",
      holdSub: "The 85 simulated guests settle without PayPal.",
      left: { label: "to charge" },
      bar: "released",
      caption: ["If bidding ended now, 19 winners would be charged.", "Nothing is charged while bidding is open."],
      note: "These figures move as bids land.",
    });
    const section = railSection(live, live.checks, "idle");
    expect(section.heading).toEqual({ text: "When bidding closes", tone: "wait" });
    expect(section.rows.map((check) => [check.mark, check.label])).toEqual([
      ["pending", "Every winner’s total is within their hold"],
      ["pending", "All of Glim’s bids stayed within their limits"],
      ["pending", "Every PayPal hold is still valid"],
    ]);
    expect(section.glim).toBe("Glim bid for 29 bidders; 9 of them are winning");
  });

  it("offers Close bidding now in a demo, with the charge off; elsewhere only the charge, off (C3)", () => {
    expect(railFoot(live, passed, idle)).toEqual({ kind: "pair", now: { label: "Close bidding now", action: "close" }, next: "Charge winners" });
    expect(railFoot({ ...live, event: { ...live.event, isDemo: false } }, passed, idle)).toEqual({ kind: "off", label: "Charge winners" });
  });

  it("has Glim say whom it is bidding for, and only claims the limits held when they did", () => {
    expect(cornerBubble(live, passed)).toEqual({ title: "I’m bidding for 29 guests", body: "84 bids, all within their limits." });
    expect(cornerBubble({ ...live, glim: glim({ bidders: 1, winners: 1, bids: 1 }) }, passed)).toEqual({
      title: "I’m bidding for 1 guest",
      body: "1 bid, within its limit.",
    });
    expect(cornerBubble({ ...live, glim: glim({ bidders: 2, bids: 5, bidsOutsideLimits: 1 }) }, passed)?.body).toBe("5 bids so far.");
    expect(cornerBubble({ ...live, glim: glim({ bidders: 0, winners: 0, bids: 0 }) }, passed)).toBeNull();
  });

  it("words the Glim line, the footer and the chips for bidding that is still open", () => {
    expect(glimLine({ glim: glim({ bidders: 1, winners: 1 }), phase: "live" })).toBe("Glim bid for 1 bidder, who is winning");
    expect(glimLine({ glim: glim({ bidders: 1, winners: 0 }), phase: "live" })).toBe("Glim bid for 1 bidder, who isn’t winning");
    expect(glimLine({ glim: glim({ bidders: 1, winners: 1 }), phase: "ready" })).toBe("Glim bid for 1 bidder, who won lots");
    expect(glimLine({ glim: glim({ bidders: 1, winners: 0 }), phase: "ready" })).toBe("Glim bid for 1 bidder, who won nothing");
    expect(lotsColumnHeader("live")).toBe("Winning now");
    expect(lotsTotalLabel({ lots: { total: 24, closed: 4, sold: 4, withoutBids: [] }, phase: "live" })).toBe("4 of 24 lots closed");
    expect(withoutBidsLine({ lots: { total: 24, closed: 4, sold: 4, withoutBids: [{ number: 22, title: "Golf" }] }, phase: "live" })).toBe("Lot 22, Golf, has no bids yet");
    expect(filterLabels("live")).toEqual({ all: "All", winners: "Winning", nothing: "Not winning" });
  });
});

describe("asking PayPal before charging", () => {
  const undecided: SettlementChecks = {
    passed: null,
    ranAt: null,
    checks: passed.checks.map((check) => ({ ...check, passed: check.key === "holds_valid" ? null : true })),
  };

  it("says Checking… with the waiting ring and the charge off while PayPal is asked", () => {
    const section = railSection(demo({ checks: undecided }), undecided, "asking");
    expect(section.heading).toEqual({ text: "Checking…", tone: "wait" });
    expect(section.rows[2]).toMatchObject({ mark: "pending", label: "Every PayPal hold is still valid" });
    expect(railFoot(demo(), undecided, { ...idle, request: "asking" })).toEqual({ kind: "off", label: "Charge 19 winners" });
    // A view that is still undecided reads Checking… until its request has been sent.
    expect(checksHeading("ready", undecided, "idle").text).toBe("Checking…");
  });

  it("does not stay on Checking… when the request failed: it says so and offers Check again", () => {
    expect(checksHeading("ready", undecided, "failed")).toEqual({ text: "Not checked yet", tone: "wait" });
    expect(railFoot(demo(), undecided, { ...idle, request: "failed" })).toEqual({
      kind: "pair",
      now: { label: "Check again", action: "check" },
      next: "Charge 19 winners",
    });
  });

  it("says Checking… again while a second ask runs, whatever the last answer was", () => {
    expect(checksHeading("ready", passed, "asking").text).toBe("Checking…");
    expect(railFoot(demo(), passed, { ...idle, request: "asking" })).toMatchObject({ kind: "off" });
  });

  it("keeps the charge off while it is being sent", () => {
    expect(railFoot(demo(), passed, { ...idle, busy: true })).toMatchObject({ kind: "cta", enabled: false });
  });
});

describe("§5 a failed check", () => {
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

  it("names the hold, leaves out the Glim line and keeps the charge off", () => {
    const section = railSection(demo({ checks: failing }), failing, "idle");
    expect(section.heading).toEqual({ text: "1 failed", tone: "fail" });
    expect(section.rows[2]).toEqual({
      key: "holds_valid",
      mark: "failed",
      label: "1 PayPal hold is no longer valid",
      details: ["Paddle 142 · Jamie K. PayPal shows it as voided."],
    });
    expect(section.glim).toBeNull();
    expect(railCopy(demo({ checks: failing })).title).toBe("Can’t charge yet");
    expect(railFoot(demo(), failing, idle)).toEqual({ kind: "pair", now: { label: "Check again", action: "check" }, next: "Charge 19 winners" });
    expect(cornerBubble(demo(), failing)).toBeNull();
  });

  it("marks the row it names, only for a problem that stops the charge", () => {
    expect([...flaggedPaddles(failing)]).toEqual([[142, "Not valid"]]);
  });

  it("puts the checks' own codes in sentences", () => {
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
      label: "2 winners are over their holds",
      details: ["Paddle 088 · Harold B. Their total is over their hold.", "Paddle 142 · Sam. There is no hold in place."],
    });
    expect([...flaggedPaddles(over)]).toEqual([
      [88, "Over hold"],
      [142, "No hold"],
    ]);
    expect(problemLine({ paddleNumber: 9, bidder: "Ana", code: "INVALID_RESOURCE_ID", blocking: true })).toBe("Paddle 009 · Ana. PayPal has no record of it.");
    expect(problemLine({ paddleNumber: 9, bidder: "Ana", code: "SOMETHING_NEW", blocking: true })).toBe("Paddle 009 · Ana. PayPal answered SOMETHING_NEW.");
  });

  it("shows two paddles at most and sends the rest to the ledger", () => {
    const many: SettlementChecks = {
      passed: false,
      ranAt: 1,
      checks: [
        {
          key: "holds_valid",
          passed: false,
          count: 3,
          problems: [1, 2, 3].map((paddleNumber) => ({ paddleNumber, bidder: "Ana", code: "VOIDED", blocking: true })),
        },
      ],
    };
    expect(checkRows(demo(), many)[0]?.details).toEqual([
      "Paddle 001 · Ana. PayPal shows it as voided.",
      "Paddle 002 · Ana. PayPal shows it as voided.",
      "And 1 more, marked in the ledger.",
    ]);
    expect(checkRows(demo(), many)[0]?.label).toBe("3 PayPal holds are no longer valid");
  });

  it("says so when Glim placed no bids", () => {
    const none = { ...passed, checks: passed.checks.map((check) => (check.key === "glim_within_limits" ? { ...check, count: 0 } : check)) };
    expect(checkRows(view(), none)[1]?.label).toBe("Glim placed no bids");
    expect(glimLine({ glim: glim({ bidders: 0, winners: 0, bids: 0 }), phase: "ready" })).toBeNull();
  });
});

describe("21's V6 row: Glim's decisions on its own (C4)", () => {
  it("sits under the bids check with its count under the words, and keeps the Glim line", () => {
    const section = railSection(view({ glim: glim({ decisions: 4 }) }), passed, "idle");
    expect(section.rows.map((check) => check.key)).toEqual(["winners_within_holds", "glim_within_limits", "glim_rules", "holds_valid"]);
    expect(section.rows[2]).toEqual({
      key: "glim_rules",
      mark: "passed",
      label: "Glim stayed inside every guest’s rules",
      details: ["4 decisions · all inside the rules"],
    });
    expect(section.glim).toBe("Glim bid for 31 bidders; 9 of them won lots");
    expect(railSection(view({ glim: glim({ decisions: 1 }) }), passed, "idle").rows[2]?.details).toEqual(["1 decision · inside the rules"]);
  });

  it("is left out until Glim has decided anything, and while bidding runs", () => {
    expect(railSection(view(), passed, "idle").rows.map((check) => check.key)).not.toContain("glim_rules");
    const live = view({ phase: "live", glim: glim({ decisions: 4 }) });
    expect(railSection(live, live.checks, "idle").rows.map((check) => check.key)).not.toContain("glim_rules");
  });

  it("says plainly when a decision fell outside a guest's rules", () => {
    expect(railSection(view({ glim: glim({ decisions: 4, decisionsOutsideRules: 1 }) }), passed, "idle").rows[2]).toEqual({
      key: "glim_rules",
      mark: "failed",
      label: "1 decision outside a guest’s rules",
      details: ["4 decisions in all"],
    });
  });
});

describe("§2 charging", () => {
  it("counts the winners in mono, shows what is left on a quiet track, and offers no second click", () => {
    const charging = demo({ phase: "charging", settlement: settlement() });
    expect(railCopy(charging)).toMatchObject({
      title: "Charging 7 of 19",
      monoFigures: true,
      mark: "lock",
      holdLine: "$43,950 held · 86 bidders",
      left: { cents: 477_000, label: "charged so far" },
      right: { cents: 339_000, label: "still to charge" },
      bar: "remaining",
      note: "You can leave this page. Charging keeps going.",
    });
    expect(railFoot(charging, passed, idle)).toEqual({ kind: "working", label: "Charging…" });
    expect(railSection(charging, passed, "idle").heading).toEqual({ text: "All passed", tone: "ok" });
    expect(cornerBubble(charging, passed)).toBeNull();
  });
});

describe("§3 charged", () => {
  const charged = demo({
    phase: "charged",
    rows: [
      row({ holdKind: "paypal", item: { id: "i", action: "capture", status: "succeeded", paypalCaptureId: "7HX40418TL552863B", errorCode: null } }),
      row({ paddleId: "p175", paddleNumber: 175, item: { id: "j", action: "simulate", status: "succeeded", paypalCaptureId: null, errorCode: null } }),
    ],
    settlement: settlement({
      status: "done",
      finishedAt: Date.parse("2026-11-08T05:30:00Z"),
      winnersSettled: 19,
      chargedCents: 816_000,
      releasedCents: 3_579_000,
      active: 0,
      releasedInFull: 67,
      receipts: 19,
    }),
  });

  it("says what was charged and released, what was done and when", () => {
    expect(railCopy(charged)).toMatchObject({
      title: "19 winners charged",
      mark: "check",
      holdLine: "Every hold is settled · 86 bidders",
      holdSub: "The 85 simulated guests settled without PayPal.",
      left: { cents: 816_000, label: "charged" },
      right: { cents: 3_579_000, label: "released" },
      bar: "released",
      caption: ["One charge per winner, for the lots they won.", "The rest of their hold was released at the same time."],
      note: "Bidders who won nothing had their whole hold released.",
    });
    expect(railSection(charged, passed, "idle")).toEqual({
      label: "Done",
      heading: { text: "9:30 PM", tone: "ok" },
      rows: [
        { key: "released", mark: "passed", label: "67 holds released in full", details: [] },
        { key: "receipts", mark: "passed", label: "19 receipts issued", details: [] },
      ],
      glim: "Glim bid for 31 bidders; 9 of them won lots",
    });
    expect(cornerBubble(charged, passed)).toEqual({ title: "Receipts are out", body: "Every winner has one." });
    expect(railCopy({ ...charged, settlement: settlement({ status: "done", winners: 1, winnersSettled: 1 }) }).title).toBe("1 winner charged");
  });

  it("puts the real charge's transaction ID above See your receipt, which shows only in demos", () => {
    expect(transactionLine(charged, 142)).toEqual({ paddleNumber: 142, captureId: "7HX40418TL552863B" });
    expect(transactionLine(charged, null)).toEqual({ paddleNumber: 142, captureId: "7HX40418TL552863B" });
    expect(transactionLine(demo(), 142)).toBeNull();
    // A keyless run's capture is made up by simulated payments, so it never shows under PayPal's name.
    const simulated = row({ holdKind: "paypal", item: { id: "i", action: "capture", status: "succeeded", paypalCaptureId: "SIMC1ED2FF3B27A40", errorCode: null } });
    expect(transactionLine({ ...charged, rows: [simulated] }, 142)).toEqual({ paddleNumber: 142, captureId: "Simulated" });
    expect(railFoot(charged, passed, { ...idle, receiptHref: "/e/gala/receipt" })).toEqual({
      kind: "cta",
      label: "See your receipt",
      action: "receipt",
      enabled: true,
    });
    expect(railFoot(charged, passed, idle)).toEqual({ kind: "none" });
    expect(railFoot({ ...charged, event: { ...charged.event, isDemo: false } }, passed, { ...idle, receiptHref: "/e/x/receipt" })).toEqual({ kind: "none" });
  });
});

describe("§4 a failed row, with retry", () => {
  const failedItem = { id: "i", action: "capture" as const, status: "failed" as const, paypalCaptureId: null, errorCode: "INSTRUMENT_DECLINED" };
  const failedRow = row({ holdKind: "paypal", item: failedItem });
  const failed = demo({
    phase: "failed",
    rows: [failedRow, row({ paddleId: "p175", paddleNumber: 175, item: { id: "j", action: "simulate", status: "succeeded", paypalCaptureId: null, errorCode: null } })],
    settlement: settlement({ status: "done_with_errors", winnersSettled: 18, chargedCents: 769_000, failed: 1, active: 0 }),
  });

  it("names the row, says what the hold does, and offers the retry from the rail", () => {
    expect(railCopy(failed)).toMatchObject({
      title: "18 charged, 1 failed",
      mark: "alert",
      holdLine: "Paddle 142 · Jamie K. · $470",
      holdSub: "PayPal declined this charge.",
      left: { cents: 769_000, label: "charged" },
      right: { cents: 47_000, label: "not charged yet" },
      bar: "remaining",
      caption: ["Jamie K.’s $500 hold stays until this goes through.", "A declined charge moves no money, so you can retry."],
      note: "The 85 simulated guests settled without PayPal.",
    });
    expect(railFoot(failed, passed, idle)).toEqual({ kind: "cta", label: "Retry 1 failed charge", action: "retry", enabled: true });
    expect(railFoot(failed, passed, { ...idle, busy: true })).toMatchObject({ enabled: false });
    expect(cornerBubble(failed, passed)).toEqual({ title: "1 receipt is waiting", body: "It goes out when this charge goes through." });
  });

  it("offers the retry from the row too", () => {
    expect(rowActionLabels(failedItem)).toEqual({ pill: "Failed", button: "Retry" });
    expect(rowStatusClass(failedItem)).toBe("failed");
  });

  it("failed with several rows, and a failed release", () => {
    const rows = [
      row({ item: { id: "i", action: "capture", status: "failed", paypalCaptureId: null, errorCode: "X" } }),
      row({ paddleId: "p2", toChargeCents: 0, item: { id: "j", action: "void", status: "failed", paypalCaptureId: null, errorCode: "Y" } }),
    ];
    const several = view({ phase: "failed", rows, settlement: settlement({ status: "done_with_errors", winnersSettled: 17, failed: 2, active: 0 }) });
    expect(railCopy(several).holdLine).toBe("2 bidders are not settled");
    expect(railCopy(several).title).toBe("17 charged, 2 failed");
    expect(railFoot(several, passed, idle)).toMatchObject({ label: "Retry 2 failed items" });
    expect(cornerBubble(several, passed)?.title).toBe("1 receipt is waiting");
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

  it("a row waiting on PayPal is asked again, and does not claim a decline", () => {
    const pendingItem = { id: "i", action: "capture" as const, status: "pending" as const, paypalCaptureId: "C", errorCode: null };
    const waiting = view({
      phase: "failed",
      rows: [row({ item: pendingItem })],
      settlement: settlement({ status: "done_with_errors", winnersSettled: 18, pending: 1, active: 0 }),
    });
    expect(railCopy(waiting).title).toBe("18 charged, 1 waiting");
    expect(railCopy(waiting).caption[1]).toBe("Asking again can’t charge anyone twice.");
    expect(railCopy(waiting).holdSub).toBe("PayPal is still working on this.");
    expect(railFoot(waiting, passed, idle)).toEqual({ kind: "cta", label: "Ask PayPal again", action: "retry", enabled: true });
    expect(rowActionLabels(pendingItem)).toEqual({ pill: "Waiting", button: "Ask again" });
  });

  it("a demo retired before anyone charged it: says so, and offers nothing", () => {
    const ended = demo({ phase: "ended" });
    expect(railCopy(ended)).toMatchObject({ title: "This event has ended", left: { cents: 0, label: "charged" }, right: { label: "released" } });
    expect(railFoot(ended, passed, idle)).toEqual({ kind: "none" });
  });
});

describe("row status (C2)", () => {
  const item = (action: "capture" | "void" | "simulate", status: "queued" | "processing" | "succeeded" | "pending" | "failed") => ({
    id: "i",
    action,
    status,
    paypalCaptureId: null,
    errorCode: null,
  });

  it("says Simulated for a guest settled in the database, Charged or Released only for a real hold", () => {
    expect(itemStatusLabel(item("simulate", "succeeded"))).toBe("Simulated");
    expect(itemStatusLabel(item("capture", "succeeded"))).toBe("Charged");
    expect(itemStatusLabel(item("void", "succeeded"))).toBe("Released");
    expect(itemStatusTone(item("simulate", "succeeded"))).toBe("simulated");
    expect(itemStatusTone(item("capture", "succeeded"))).toBe("charged");
    expect(itemStatusTone(item("void", "succeeded"))).toBe("released");
  });

  it("only says Charging of a real hold", () => {
    expect(itemStatusLabel(item("capture", "queued"))).toBe("Queued");
    expect(itemStatusLabel(item("capture", "processing"))).toBe("Charging…");
    expect(itemStatusLabel(item("capture", "pending"))).toBe("Waiting on PayPal");
    expect(itemStatusLabel(item("capture", "failed"))).toBe("Failed");
    expect(itemStatusLabel(item("void", "processing"))).toBe("Releasing…");
    expect(itemStatusLabel(item("simulate", "processing"))).toBe("Settling…");
    expect(itemStatusTone(item("capture", "processing"))).toBe("working");
    expect(itemStatusTone(item("simulate", "queued"))).toBe("queued");
  });

  it("marks a row that needs the organizer", () => {
    expect(canRetry(item("capture", "failed"))).toBe(true);
    expect(canRetry(item("capture", "pending"))).toBe(true);
    expect(canRetry(item("capture", "succeeded"))).toBe(false);
    expect(canRetry(null)).toBe(false);
    expect(rowActionLabels(item("capture", "succeeded"))).toBeNull();

    expect(rowStatusClass(null)).toBeNull();
    expect(rowStatusClass(item("capture", "processing"))).toBe("charging");
    expect(rowStatusClass(item("capture", "succeeded"))).toBe("charged");
    expect(rowStatusClass(item("capture", "failed"))).toBe("failed");
    expect(rowStatusClass(item("capture", "pending"))).toBe("failed");
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
