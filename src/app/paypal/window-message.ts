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
