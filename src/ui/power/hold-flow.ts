/**
 * The hold button's states, as a reducer with no React or browser in it. Three sources report on one
 * window (the window's own messages, the stream's hold rows and polling the hold), in any order and
 * more than once, so every transition has to tolerate a repeat.
 *
 * The words of every state live here: design/20's frames 9 to 11 for the window, its nearest frame
 * for the states it doesn't draw (still confirming, a lost window, a refused approval).
 */
import type { PaypalWindowOutcome } from "@/app/paypal/window-message";
import type { HoldStatus } from "@/server/paypal/hold-store";

import { formatUsd } from "../format";

import type { WindowRoute } from "./hold-window";

export type HoldFlowState =
  | { phase: "idle" }
  /** The server call is on its way, with the blank window up if the browser allowed one. */
  | { phase: "opening"; amountCents: number }
  /** PayPal's page is open. `windowLost`: the window reports closed, so the guest may start over. */
  | { phase: "waiting"; amountCents: number; holdId: string; approvalUrl: string; windowLost: boolean }
  /** The popup was blocked and this tab is on its way to PayPal. */
  | { phase: "redirecting"; amountCents: number }
  /** design/17 frame 5: the popup was blocked; the hold waits for "Continue to PayPal in this tab". */
  | { phase: "blocked"; amountCents: number; holdId: string; approvalUrl: string }
  /** The guest approved and PayPal has not finished; the webhook may be what completes it. */
  | { phase: "confirming"; amountCents: number; holdId: string }
  | { phase: "approved"; amountCents: number; holdId: string }
  | { phase: "canceled"; amountCents: number }
  /** PayPal authorized it, but it could not become the bidding power (holdSwapRefusal). */
  | { phase: "refused"; amountCents: number }
  | { phase: "failed"; amountCents: number; message: string };

export type HoldFlowEvent =
  | { type: "start"; amountCents: number }
  | { type: "created"; holdId: string; approvalUrl: string; route: WindowRoute }
  | { type: "create_failed"; message: string }
  | { type: "window_outcome"; outcome: PaypalWindowOutcome }
  | { type: "hold_status"; status: HoldStatus }
  | { type: "window_lost" }
  | { type: "reset" };

export const IDLE: HoldFlowState = { phase: "idle" };

const DECLINED_LINE = "PayPal declined the hold. Nothing was held. Try another amount or payment method.";
const FAILED_LINE = "PayPal could not place the hold. Nothing was held. Please try again.";

type WatchedState = Extract<HoldFlowState, { phase: "waiting" | "confirming" }>;

function isWatched(state: HoldFlowState): state is WatchedState {
  return state.phase === "waiting" || state.phase === "confirming";
}

function afterOutcome(state: WatchedState, outcome: PaypalWindowOutcome): HoldFlowState {
  const { amountCents, holdId } = state;
  switch (outcome) {
    case "approved":
      return { phase: "approved", amountCents, holdId };
    case "pending":
      return { phase: "confirming", amountCents, holdId };
    case "canceled":
      return { phase: "canceled", amountCents };
    case "refused":
      return { phase: "refused", amountCents };
    case "declined":
      return { phase: "failed", amountCents, message: DECLINED_LINE };
    case "error":
      return { phase: "failed", amountCents, message: FAILED_LINE };
  }
}

/** What a hold's stored status says about its window; null while it is still open. */
function outcomeOfStatus(status: HoldStatus): PaypalWindowOutcome | null {
  switch (status) {
    case "pending_approval":
      return null;
    case "authorized":
      return "approved";
    case "canceled":
      return "canceled";
    case "denied":
      return "declined";
    // A window's own hold only gets here through an approval that could not stand: refused, or
    // authorized after it was canceled.
    case "replaced":
    case "voided":
      return "refused";
    case "failed":
    case "captured":
    case "expired":
      return "error";
  }
}

export function holdFlowReducer(state: HoldFlowState, event: HoldFlowEvent): HoldFlowState {
  switch (event.type) {
    case "start":
      return { phase: "opening", amountCents: event.amountCents };
    case "created":
      if (state.phase !== "opening") return state;
      if (event.route === "blocked") {
        return { phase: "blocked", amountCents: state.amountCents, holdId: event.holdId, approvalUrl: event.approvalUrl };
      }
      return event.route === "redirect"
        ? { phase: "redirecting", amountCents: state.amountCents }
        : {
            phase: "waiting",
            amountCents: state.amountCents,
            holdId: event.holdId,
            approvalUrl: event.approvalUrl,
            windowLost: false,
          };
    case "create_failed":
      return state.phase === "opening" ? { phase: "failed", amountCents: state.amountCents, message: event.message } : state;
    case "window_outcome":
      return isWatched(state) ? afterOutcome(state, event.outcome) : state;
    case "hold_status": {
      const outcome = outcomeOfStatus(event.status);
      return outcome !== null && isWatched(state) ? afterOutcome(state, outcome) : state;
    }
    case "window_lost":
      return state.phase === "waiting" ? { ...state, windowLost: true } : state;
    case "reset":
      return state.phase === "approved" ? state : IDLE;
  }
}

/** The hold being watched, while one is: its window can still report, and polling should run. */
export function watchedHoldId(state: HoldFlowState): string | null {
  return isWatched(state) ? state.holdId : null;
}

/** design/20's quiet panel right above the button, saying what just happened (frames 10 and 11). */
export interface HoldNotice {
  /** The mark in its white circle: a cross after a cancel, "!" after anything else, a spinner while PayPal confirms. */
  mark: "canceled" | "failed" | "confirming";
  title: string;
  body: string;
}

export interface HoldFlowCopy {
  /** The button's label, or the status's while `status` is set. */
  button: string;
  /** False while something is in flight or the amount cannot be held. */
  buttonEnabled: boolean;
  /** True while the amount may not change. */
  locked: boolean;
  /**
   * The button's slot shows a status instead of the button (design/20 frame 9): "waiting" with a
   * spinner while the window is open, "done" once the hold landed.
   */
  status: "waiting" | "done" | null;
  notice: HoldNotice | null;
  /** The line under the button; null keeps the page's own. */
  trust: string | null;
  /** Where "Continue in this tab" goes, when the window may be hidden or swallowed. */
  continueHref: string | null;
  /** Replaces the amount's note while it can't change; null keeps the page's own. */
  amountNote: string | null;
  /** design/17 frame 5 draws the button with 09's arrow and the line with a window, not a lock. */
  buttonIcon?: "arrow";
  trustIcon?: "window";
}

/** design/17 frame 5, while the amount on screen is the blocked hold's. */
const BLOCKED_BUTTON = "Continue to PayPal in this tab";
const BLOCKED_TRUST = "Your browser blocked the PayPal window. You’ll come back here to bid.";

const NOTHING_HELD = "Nothing was held.";
/** What POST /api/holds/[slug] answers when PayPal would not start the hold (src/server/holds/create.ts). */
export const PAYPAL_UNAVAILABLE_LINE = "PayPal could not start this hold. Nothing was held. Please try again.";

/** A failure's notice: PayPal's own failures in frame 11's words, anything else as the server said it. */
export function failureNotice(message: string): HoldNotice {
  if (message === DECLINED_LINE) {
    return { mark: "failed", title: "PayPal declined the hold", body: "Nothing was held. Try another amount or payment method." };
  }
  if (message === FAILED_LINE || message === PAYPAL_UNAVAILABLE_LINE) {
    return { mark: "failed", title: "PayPal didn’t respond", body: NOTHING_HELD };
  }
  return { mark: "failed", title: message, body: NOTHING_HELD };
}

/** `chosenCents` is the amount on screen, or null when it cannot be held. */
export function holdFlowCopy(state: HoldFlowState, chosenCents: number | null): HoldFlowCopy {
  const ready: HoldFlowCopy = {
    button: chosenCents === null ? "Hold with PayPal" : `Hold ${formatUsd(chosenCents)} with PayPal`,
    buttonEnabled: chosenCents !== null,
    locked: false,
    status: null,
    notice: null,
    trust: null,
    continueHref: null,
    amountNote: null,
  };
  // After a cancel or a failure the same amount is one press away; a new amount starts over.
  const again = (notice: HoldNotice): HoldFlowCopy => ({
    ...ready,
    button: chosenCents === null ? ready.button : "Try again",
    notice,
  });
  const waiting = (button: string): HoldFlowCopy => ({
    ...ready,
    button,
    buttonEnabled: false,
    locked: true,
    status: "waiting",
    trust: "Nothing is held until you approve.",
    amountNote: "Can’t change while the PayPal window is open",
  });

  switch (state.phase) {
    case "idle":
      return ready;
    case "opening":
    case "redirecting":
      return waiting("Opening PayPal…");
    case "blocked":
      // Another amount on screen is a new hold, so the button says so again.
      return chosenCents === state.amountCents
        ? { ...ready, button: BLOCKED_BUTTON, trust: BLOCKED_TRUST, buttonIcon: "arrow", trustIcon: "window" }
        : ready;
    case "waiting":
      return state.windowLost
        ? again({
            mark: "failed",
            title: "We can’t see the PayPal window",
            body: "If it’s still open, finish there. Otherwise, try again.",
          })
        : { ...waiting("Finish in the PayPal window"), continueHref: state.approvalUrl };
    case "confirming":
      // Rare, and it can take a while, so it does not lock the guest out: if this hold lands after
      // they tried again, the swap keeps one hold and releases the other.
      return {
        ...ready,
        notice: {
          mark: "confirming",
          title: "Still confirming with PayPal",
          body: "Your bidding power updates as soon as it does.",
        },
      };
    case "approved":
      return {
        ...ready,
        button: `${formatUsd(state.amountCents)} is on hold with PayPal`,
        buttonEnabled: false,
        locked: true,
        status: "done",
        trust: "Taking you back to bid…",
      };
    case "canceled":
      return again({ mark: "canceled", title: "Canceled in PayPal", body: NOTHING_HELD });
    case "refused":
      return {
        ...ready,
        notice: { mark: "failed", title: "Your bidding power stayed as it was", body: "The PayPal window says why." },
      };
    case "failed":
      return again(failureNotice(state.message));
  }
}
