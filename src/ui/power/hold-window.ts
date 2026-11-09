/**
 * The PayPal window, from the page that opens it. Free of React and written against small slices of
 * `window`, so the popup and redirect decisions can be tested without a browser.
 *
 * The order matters. Browsers allow a popup only inside the click, and the approval link exists
 * only after a server call, so the click opens a blank window and the answer sets its location. A
 * browser that blocks it gets a full-page redirect instead: PayPal's return page then brings the
 * guest back by itself (src/server/paypal/window-page.ts).
 */
import {
  isPaypalWindowMessage,
  PAYPAL_WINDOW_CHANNEL,
  type PaypalWindowMessage,
} from "@/app/paypal/window-message";

/** One name, so a retry reuses a window left open instead of piling up another. */
export const PAYPAL_WINDOW_NAME = "fairhold-paypal";
const PAYPAL_WINDOW_FEATURES = "popup=yes,width=520,height=720";

export interface PopupLike {
  readonly closed: boolean;
  readonly location: { replace(url: string): void };
  readonly document?: { body: { textContent: string | null } | null };
  focus(): void;
  close(): void;
}

export interface OpenerLike {
  open(url: string, target: string, features: string): PopupLike | null;
  readonly location: { assign(url: string): void };
}

/** Call it inside the click. Null when the browser blocked the window, however it says so. */
export function openBlankWindow(opener: OpenerLike): PopupLike | null {
  let popup: PopupLike | null;
  try {
    popup = opener.open("", PAYPAL_WINDOW_NAME, PAYPAL_WINDOW_FEATURES);
  } catch {
    return null;
  }
  if (!popup || popup.closed) return null;
  try {
    // The blank page stays up until the server answers. Plain until design/17 is approved.
    if (popup.document?.body) popup.document.body.textContent = "Opening PayPal…";
  } catch {
    // The window is still usable without its line.
  }
  return popup;
}

export type WindowRoute = "popup" | "redirect";

/**
 * Sends the guest to PayPal: in the window when it is still there, otherwise in this tab. A window
 * closed in the meantime counts as blocked, because blockers can also kill a popup after opening it.
 */
export function goToApproval(popup: PopupLike | null, approvalUrl: string, opener: OpenerLike): WindowRoute {
  if (popup && !popup.closed) {
    try {
      popup.location.replace(approvalUrl);
      popup.focus();
      return "popup";
    } catch {
      // A window we can no longer steer is as good as blocked.
    }
  }
  opener.location.assign(approvalUrl);
  return "redirect";
}

export function closeWindow(popup: PopupLike | null): void {
  try {
    if (popup && !popup.closed) popup.close();
  } catch {
    // Nothing more to do for a window that will not close.
  }
}

export interface ListenerHost {
  readonly location: { origin: string };
  addEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { origin: string; data: unknown }) => void): void;
  /** Hears a BroadcastChannel where the browser has one; returns how to stop. */
  listenToChannel(name: string, onData: (data: unknown) => void): () => void;
}

/**
 * Hears both ways the PayPal window reports (src/app/paypal/window-message.ts): the BroadcastChannel,
 * which works even when PayPal's pages cut the popup off from its opener, and postMessage, which
 * works where BroadcastChannel is missing. Usually both arrive, so the listener must not mind.
 */
export function listenForPaypalWindow(host: ListenerHost, listener: (message: PaypalWindowMessage) => void): () => void {
  const stopChannel = host.listenToChannel(PAYPAL_WINDOW_CHANNEL, (data) => {
    if (isPaypalWindowMessage(data)) listener(data);
  });
  const onMessage = (event: { origin: string; data: unknown }) => {
    if (event.origin === host.location.origin && isPaypalWindowMessage(event.data)) listener(event.data);
  };
  host.addEventListener("message", onMessage);
  return () => {
    host.removeEventListener("message", onMessage);
    stopChannel();
  };
}

/** The real `window` as a ListenerHost. */
export function browserListenerHost(browser: Window): ListenerHost {
  return {
    location: browser.location,
    addEventListener: (type, listener) => browser.addEventListener(type, listener),
    removeEventListener: (type, listener) => browser.removeEventListener(type, listener),
    listenToChannel: (name, onData) => {
      if (typeof BroadcastChannel === "undefined") return () => {};
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => onData(event.data);
      return () => channel.close();
    },
  };
}
