/**
 * The hold button's states, as a reducer with no React or browser in it. Three sources report on one
 * window (the window's own messages, the stream's hold rows and polling the hold), in any order and
 * more than once, so every transition has to tolerate a repeat.
 *
 * Only the idle state is approved (09). The lines below are the plain copy for the undrawn states
 * until design/20 and design/17 are approved; they all live here so they are easy to replace.
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

export interface HoldFlowCopy {
  /** The button's label. */
  button: string;
  /** False while something is in flight or the amount cannot be held. */
  buttonEnabled: boolean;
  /** True while the amount may not change. */
  locked: boolean;
  /** A plain line above the button, saying what just happened. */
  notice: string | null;
  /** The line under the button; null keeps the page's own. */
  trust: string | null;
  /** Where "Continue in this tab" goes, when the window may be hidden or swallowed. */
  continueHref: string | null;
}

/** `chosenCents` is the amount on screen, or null when it cannot be held. */
export function holdFlowCopy(state: HoldFlowState, chosenCents: number | null): HoldFlowCopy {
  const ready: HoldFlowCopy = {
    button: chosenCents === null ? "Hold with PayPal" : `Hold ${formatUsd(chosenCents)} with PayPal`,
    buttonEnabled: chosenCents !== null,
    locked: false,
    notice: null,
    trust: null,
    continueHref: null,
  };
  const busy = (button: string, trust: string | null = null): HoldFlowCopy => ({
    ...ready,
    button,
    buttonEnabled: false,
    locked: true,
    trust,
  });

  switch (state.phase) {
    case "idle":
      return ready;
    case "opening":
    case "redirecting":
      return busy("Opening PayPal…");
    case "waiting":
      return state.windowLost
        ? {
            ...ready,
            notice: "We can’t see the PayPal window any more. If it’s still open, finish there. Otherwise, try again.",
          }
        : { ...busy("Finish in the PayPal window", "Nothing is held until you approve."), continueHref: state.approvalUrl };
    case "confirming":
      // Rare, and it can take a while, so it does not lock the guest out: if this hold lands after
      // they tried again, the swap keeps one hold and releases the other.
      return { ...ready, notice: "Still confirming with PayPal. Your bidding power updates as soon as it does." };
    case "approved":
      return busy(`${formatUsd(state.amountCents)} is on hold with PayPal`, "Taking you back to bid…");
    case "canceled":
      return { ...ready, notice: "Canceled in PayPal. Nothing was held." };
    case "refused":
      return { ...ready, notice: "Your bidding power stayed as it was. The PayPal window says why." };
    case "failed":
      return { ...ready, notice: state.message };
  }
}
