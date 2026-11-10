import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { PaypalWindowOutcome } from "@/app/paypal/window-message";
import type { HoldStatus } from "@/server/paypal/hold-store";
import {
  holdFlowCopy,
  holdFlowReducer,
  IDLE,
  PAYPAL_UNAVAILABLE_LINE,
  watchedHoldId,
  type HoldFlowEvent,
  type HoldFlowState,
} from "@/ui/power/hold-flow";

const run = (events: HoldFlowEvent[], from: HoldFlowState = IDLE) => events.reduce(holdFlowReducer, from);

const OPENED: HoldFlowEvent[] = [
  { type: "start", amountCents: 500_00 },
  { type: "created", holdId: "hold-1", approvalUrl: "https://paypal.example/a", route: "popup" },
];

describe("holdFlowReducer", () => {
  it("goes from the click to waiting on the window", () => {
    expect(run([{ type: "start", amountCents: 500_00 }])).toEqual({ phase: "opening", amountCents: 500_00 });
    expect(run(OPENED)).toEqual({
      phase: "waiting",
      amountCents: 500_00,
      holdId: "hold-1",
      approvalUrl: "https://paypal.example/a",
      windowLost: false,
    });
  });

  it("does not wait on a window after a redirect", () => {
    const state = run([
      { type: "start", amountCents: 500_00 },
      { type: "created", holdId: "hold-1", approvalUrl: "https://paypal.example/a", route: "redirect" },
    ]);
    expect(state).toEqual({ phase: "redirecting", amountCents: 500_00 });
    expect(watchedHoldId(state)).toBeNull();
  });

  it("turns a failed server call into a line to read", () => {
    expect(run([{ type: "start", amountCents: 500_00 }, { type: "create_failed", message: "No." }])).toEqual({
      phase: "failed",
      amountCents: 500_00,
      message: "No.",
    });
  });

  it.each<[PaypalWindowOutcome, HoldFlowState["phase"]]>([
    ["approved", "approved"],
    ["pending", "confirming"],
    ["canceled", "canceled"],
    ["refused", "refused"],
    ["declined", "failed"],
    ["error", "failed"],
  ])("reads the window's %s as %s", (outcome, phase) => {
    expect(run([...OPENED, { type: "window_outcome", outcome }]).phase).toBe(phase);
  });

  it.each<[HoldStatus, HoldFlowState["phase"]]>([
    ["pending_approval", "waiting"],
    ["authorized", "approved"],
    ["canceled", "canceled"],
    ["denied", "failed"],
    ["failed", "failed"],
    ["replaced", "refused"],
    ["voided", "refused"],
    ["expired", "failed"],
    ["captured", "failed"],
  ])("reads a polled status %s as %s", (status, phase) => {
    expect(run([...OPENED, { type: "hold_status", status }]).phase).toBe(phase);
  });

  it("does not mind hearing the same news again, in any order", () => {
    const approved = run([...OPENED, { type: "window_outcome", outcome: "approved" }]);
    expect(run([{ type: "window_outcome", outcome: "approved" }], approved)).toEqual(approved);
    expect(run([{ type: "hold_status", status: "authorized" }], approved)).toEqual(approved);
    // The poll that was already on its way, answering what the hold was a moment ago.
    expect(run([{ type: "hold_status", status: "pending_approval" }], approved)).toEqual(approved);
    expect(run([{ type: "window_outcome", outcome: "canceled" }], approved)).toEqual(approved);
  });

  it("moves on from still confirming when the webhook finishes the hold", () => {
    const confirming = run([...OPENED, { type: "window_outcome", outcome: "pending" }]);
    expect(watchedHoldId(confirming)).toBe("hold-1");
    expect(run([{ type: "hold_status", status: "pending_approval" }], confirming)).toEqual(confirming);
    expect(run([{ type: "hold_status", status: "authorized" }], confirming).phase).toBe("approved");
  });

  it("keeps listening after the window is lost, and lets the guest start over", () => {
    const lost = run([...OPENED, { type: "window_lost" }]);
    expect(lost).toMatchObject({ phase: "waiting", windowLost: true });
    expect(watchedHoldId(lost)).toBe("hold-1");
    // PayPal's pages can cut the window off while it is still open, so it can still be approved.
    expect(run([{ type: "window_outcome", outcome: "approved" }], lost).phase).toBe("approved");
    expect(run([{ type: "start", amountCents: 250_00 }], lost)).toEqual({ phase: "opening", amountCents: 250_00 });
  });

  it("ignores a window's news when no window is being watched", () => {
    expect(run([{ type: "window_outcome", outcome: "approved" }])).toEqual(IDLE);
    expect(run([{ type: "hold_status", status: "authorized" }])).toEqual(IDLE);
    expect(run([{ type: "window_lost" }])).toEqual(IDLE);
    expect(run([{ type: "created", holdId: "h", approvalUrl: "u", route: "popup" }])).toEqual(IDLE);
    expect(run([{ type: "create_failed", message: "No." }])).toEqual(IDLE);
  });

  it("resets to choosing, except once a hold has landed", () => {
    expect(run([...OPENED, { type: "window_outcome", outcome: "canceled" }, { type: "reset" }])).toEqual(IDLE);
    expect(run([...OPENED, { type: "window_outcome", outcome: "approved" }, { type: "reset" }]).phase).toBe("approved");
  });

  it("watches only a window that can still report", () => {
    expect(watchedHoldId(IDLE)).toBeNull();
    expect(watchedHoldId(run(OPENED))).toBe("hold-1");
    expect(watchedHoldId(run([...OPENED, { type: "window_outcome", outcome: "approved" }]))).toBeNull();
    expect(watchedHoldId(run([...OPENED, { type: "window_outcome", outcome: "canceled" }]))).toBeNull();
  });
});

describe("holdFlowCopy", () => {
  it("offers the approved button when there is an amount", () => {
    expect(holdFlowCopy(IDLE, 500_00)).toEqual({
      button: "Hold $500 with PayPal",
      buttonEnabled: true,
      locked: false,
      status: null,
      notice: null,
      trust: null,
      continueHref: null,
      amountNote: null,
    });
    expect(holdFlowCopy(IDLE, 1_000_00).button).toBe("Hold $1,000 with PayPal");
  });

  it("names no amount, and offers nothing, when the amount cannot be held", () => {
    expect(holdFlowCopy(IDLE, null)).toMatchObject({ button: "Hold with PayPal", buttonEnabled: false });
  });

  it("shows frame 9 while the window is open: a status, the amount locked, and this tab", () => {
    expect(holdFlowCopy(run(OPENED), 500_00)).toMatchObject({
      button: "Finish in the PayPal window",
      buttonEnabled: false,
      locked: true,
      status: "waiting",
      trust: "Nothing is held until you approve.",
      continueHref: "https://paypal.example/a",
      amountNote: "Can’t change while the PayPal window is open",
    });
  });

  it("waits the same way while the window opens, with no tab to offer yet", () => {
    expect(holdFlowCopy(run([{ type: "start", amountCents: 500_00 }]), 500_00)).toMatchObject({
      button: "Opening PayPal…",
      status: "waiting",
      locked: true,
      continueHref: null,
    });
  });

  it("shows frame 10 after a cancel: nothing was held, and Try again", () => {
    const canceled = holdFlowCopy(run([...OPENED, { type: "window_outcome", outcome: "canceled" }]), 500_00);
    expect(canceled).toMatchObject({ button: "Try again", buttonEnabled: true, locked: false, status: null });
    expect(canceled.notice).toEqual({ mark: "canceled", title: "Canceled in PayPal", body: "Nothing was held." });
  });

  it("shows frame 11 when PayPal fails, whether in the window or before it opened", () => {
    const failed = holdFlowCopy(run([...OPENED, { type: "window_outcome", outcome: "error" }]), 500_00);
    expect(failed).toMatchObject({ button: "Try again", buttonEnabled: true });
    expect(failed.notice).toEqual({ mark: "failed", title: "PayPal didn’t respond", body: "Nothing was held." });

    const unavailable = run([{ type: "start", amountCents: 500_00 }, { type: "create_failed", message: PAYPAL_UNAVAILABLE_LINE }]);
    expect(holdFlowCopy(unavailable, 500_00).notice).toEqual(failed.notice);

    const declined = holdFlowCopy(run([...OPENED, { type: "window_outcome", outcome: "declined" }]), 500_00);
    expect(declined.notice).toMatchObject({ title: "PayPal declined the hold" });
    expect(declined.notice?.body).toContain("Nothing was held.");
  });

  it("titles any other refusal with the server's sentence", () => {
    const refused = run([
      { type: "start", amountCents: 500_00 },
      { type: "create_failed", message: "Bidding has closed for this event." },
    ]);
    expect(holdFlowCopy(refused, 500_00).notice).toEqual({
      mark: "failed",
      title: "Bidding has closed for this event.",
      body: "Nothing was held.",
    });
  });

  it("keeps the API's PayPal sentence, so frame 11 knows it", () => {
    const source = readFileSync(path.join(process.cwd(), "src/server/holds/create.ts"), "utf8");
    expect(source).toContain(JSON.stringify(PAYPAL_UNAVAILABLE_LINE));
  });

  it("offers the button, not Try again, once the amount can't be held", () => {
    const canceled = run([...OPENED, { type: "window_outcome", outcome: "canceled" }]);
    expect(holdFlowCopy(canceled, null)).toMatchObject({ button: "Hold with PayPal", buttonEnabled: false });
  });

  it("says the hold landed, for the amount that landed", () => {
    const approved = run([...OPENED, { type: "window_outcome", outcome: "approved" }]);
    // The amount on screen no longer counts: the page has refreshed around the new hold.
    expect(holdFlowCopy(approved, null)).toMatchObject({
      button: "$500 is on hold with PayPal",
      buttonEnabled: false,
      status: "done",
      trust: "Taking you back to bid…",
    });
  });

  it("does not lock the guest out while PayPal is still confirming", () => {
    const copy = holdFlowCopy(run([...OPENED, { type: "window_outcome", outcome: "pending" }]), 500_00);
    expect(copy).toMatchObject({ button: "Hold $500 with PayPal", buttonEnabled: true, locked: false, status: null });
    expect(copy.notice).toMatchObject({ mark: "confirming", title: "Still confirming with PayPal" });
  });

  it("lets the guest start over when the window is lost, and says it may still be open", () => {
    const copy = holdFlowCopy(run([...OPENED, { type: "window_lost" }]), 500_00);
    expect(copy).toMatchObject({ button: "Try again", buttonEnabled: true, locked: false, continueHref: null, status: null });
    expect(copy.notice?.body).toContain("If it’s still open, finish there");
  });

  it("uses no word the brand rules forbid", () => {
    const states: HoldFlowState[] = [
      IDLE,
      run([{ type: "start", amountCents: 500_00 }]),
      run(OPENED),
      run([...OPENED, { type: "window_lost" }]),
      ...(["approved", "pending", "canceled", "refused", "declined", "error"] as const).map((outcome) =>
        run([...OPENED, { type: "window_outcome", outcome }]),
      ),
    ];
    for (const state of states) {
      const copy = holdFlowCopy(state, 500_00);
      const words = `${copy.button} ${copy.notice?.title} ${copy.notice?.body} ${copy.trust} ${copy.amountNote}`;
      expect(words).not.toMatch(/FMV|IRS|guarantee|tax/i);
    }
  });
});
