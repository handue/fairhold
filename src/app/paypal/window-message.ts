/**
 * What the PayPal return and cancel pages tell the tab that opened the PayPal window. Framework-
 * free so the opener's client code can import it. The pages send it twice: on a BroadcastChannel,
 * which reaches the guest's other tabs even when PayPal's pages cut the popup off from its
 * opener, and with postMessage to window.opener, targeted at this origin.
 *
 * Listening, in the opener:
 *
 *   const channel = new BroadcastChannel(PAYPAL_WINDOW_CHANNEL);
 *   channel.onmessage = (event) => { if (isPaypalWindowMessage(event.data)) ... };
 *   window.addEventListener("message", (event) => {
 *     if (event.origin === window.location.origin && isPaypalWindowMessage(event.data)) ...
 *   });
 */

export const PAYPAL_WINDOW_CHANNEL = "fairhold:paypal-window";

/**
 * Set to the hold's id, in sessionStorage, by 09's "Continue to PayPal in this tab" (design/17
 * frame 5) before it sends its own tab to PayPal. The return and cancel pages then know they are the
 * gala tab itself, with no window to close, and go back to the auction.
 */
export const PAYPAL_IN_TAB_KEY = "fairhold:paypal-in-tab";

/** design/17 frame 1, which the window opens on while the server creates the order. */
export function paypalStartHref(slug: string, amountCents: number): string {
  return `/paypal/start?e=${encodeURIComponent(slug)}&amount=${amountCents}`;
}
export const PAYPAL_WINDOW_MESSAGE_TYPE = "fairhold:paypal-hold";

/** `refused`: PayPal approved the hold, but the bidding power stayed as it was and the approval was released. */
export const PAYPAL_WINDOW_OUTCOMES = ["approved", "pending", "declined", "canceled", "refused", "error"] as const;
export type PaypalWindowOutcome = (typeof PAYPAL_WINDOW_OUTCOMES)[number];

export interface PaypalWindowMessage {
  type: typeof PAYPAL_WINDOW_MESSAGE_TYPE;
  outcome: PaypalWindowOutcome;
  /** Null when the page could not tell which hold it was about. */
  holdId: string | null;
}

export function isPaypalWindowMessage(value: unknown): value is PaypalWindowMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === PAYPAL_WINDOW_MESSAGE_TYPE &&
    (PAYPAL_WINDOW_OUTCOMES as readonly unknown[]).includes(message.outcome) &&
    (message.holdId === null || typeof message.holdId === "string")
  );
}
