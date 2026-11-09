/**
 * The page the PayPal window lands on after approval or cancel. Deliberately unstyled until its
 * design is approved: it says what happened, notifies the opener, then closes itself as a popup or
 * returns to the auction after a full-page redirect.
 */
import {
  PAYPAL_WINDOW_CHANNEL,
  PAYPAL_WINDOW_MESSAGE_TYPE,
  type PaypalWindowMessage,
  type PaypalWindowOutcome,
} from "@/app/paypal/window-message";

export interface PaypalWindowPage {
  status: number;
  outcome: PaypalWindowOutcome;
  holdId: string | null;
  heading: string;
  detail: string;
  /** "Back to the auction": a page of the hold's own event, or home; build it with backHrefFor(). */
  backHref: string;
}

/** Popups close this long after the message is sent. */
const CLOSE_DELAY_MS = 300;
/** If the window is still open by then, it was a full-page redirect: go back to the auction. */
const RETURN_DELAY_MS = 1500;
/** Outcomes the guest has to read: the page stays up instead of closing or returning. */
const STAYS_OPEN: ReadonlySet<PaypalWindowOutcome> = new Set(["error", "refused"]);

export function paypalWindowResponse(page: PaypalWindowPage): Response {
  return new Response(renderPaypalWindowHtml(page), {
    status: page.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // The URL carries PayPal's token and payer id; keep them out of Referer headers.
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex",
    },
  });
}

export function renderPaypalWindowHtml(page: PaypalWindowPage): string {
  const message: PaypalWindowMessage = {
    type: PAYPAL_WINDOW_MESSAGE_TYPE,
    outcome: page.outcome,
    holdId: page.holdId,
  };
  const leave = STAYS_OPEN.has(page.outcome)
    ? ""
    : `
  setTimeout(function () { window.close(); }, ${CLOSE_DELAY_MS});
  setTimeout(function () { if (!window.closed) window.location.replace(${scriptJson(page.backHref)}); }, ${RETURN_DELAY_MS});`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(page.heading)} · Fairhold</title>
</head>
<body>
<main>
<h1>${escapeHtml(page.heading)}</h1>
<p>${escapeHtml(page.detail)}</p>
<p><a href="${escapeHtml(page.backHref)}">Back to the auction</a></p>
</main>
<script>
(function () {
  var message = ${scriptJson(message)};
  try {
    var channel = new BroadcastChannel(${scriptJson(PAYPAL_WINDOW_CHANNEL)});
    channel.postMessage(message);
    channel.close();
  } catch (error) {}
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(message, window.location.origin);
  } catch (error) {}${leave}
})();
</script>
</body>
</html>
`;
}

const BASE = "https://fairhold.invalid";
const MAX_NEXT_LENGTH = 1024;

/**
 * Where "Back to the auction" goes, and where a full-page redirect returns: the guest's `next`
 * path when it is a page of the hold's own event, else that event's page (home without one). The
 * check runs on the path a browser would follow, after URL parsing has resolved dot segments,
 * escapes and backslashes: "/.//evil.example" and "/x/..//evil.example" both resolve to the
 * protocol-relative "//evil.example", another site, so checking the origin alone is not enough.
 */
export function backHrefFor(next: string | null, eventSlug: string | null): string {
  if (!eventSlug) return "/";
  const eventPage = `/e/${encodeURIComponent(eventSlug)}`;
  if (!next || !next.startsWith("/") || next.length > MAX_NEXT_LENGTH) return eventPage;
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return eventPage;
  }
  const ofThisEvent = url.pathname === eventPage || url.pathname.startsWith(`${eventPage}/`);
  return url.origin === BASE && ofThisEvent ? `${url.pathname}${url.search}${url.hash}` : eventPage;
}

/**
 * Where a guest goes to try again after a canceled or declined window: the event's bidding power
 * page, still holding the way back to `next`.
 */
export function retryHrefFor(next: string | null, eventSlug: string | null): string {
  if (!eventSlug) return "/";
  const eventPage = `/e/${encodeURIComponent(eventSlug)}`;
  const power = `${eventPage}/power`;
  const onward = backHrefFor(next, eventSlug);
  return onward === eventPage || onward.split(/[?#]/)[0] === power ? power : `${power}?next=${encodeURIComponent(onward)}`;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** JSON that is safe inside an inline script: it can never close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll(" ", "\\u2028")
    .replaceAll(" ", "\\u2029");
}
