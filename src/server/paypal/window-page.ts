/**
 * The pages of the PayPal window (design/17): Fairhold's own, neutral, around PayPal's. They are
 * route handlers that write HTML themselves, because the return page has to answer with the
 * approval's own status and keep PayPal's token out of the Referer header.
 *
 * - Frame 1, "Opening PayPal…": /paypal/start, which the window shows while the server creates
 *   the order (`renderPaypalStartHtml`).
 * - Frame 2, "Approving your hold…": the return page, while Fairhold asks PayPal to place the hold.
 *   When PayPal answers quickly the page goes straight to the outcome; otherwise frame 2 is sent
 *   first and the outcome follows in the same response (`paypalWindowResponseWhenReady`).
 * - Frame 3, "Approved", and frame 4, "Canceled". The other outcomes have no image and take the
 *   nearest frame's layout with their own lines.
 *
 * Every outcome page tells the tab that opened the window (src/app/paypal/window-message.ts). An
 * approval closes the window after 3 seconds; a full-page trip to PayPal, from 09's "Continue to
 * PayPal in this tab", goes back to the auction instead.
 */
import {
  PAYPAL_IN_TAB_KEY,
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
  /** One or two sentences; "\n" starts a new line, as the frames break them. */
  detail: string;
  /** "Back to the auction": a page of the hold's own event, or home; build it with backHrefFor(). */
  backHref: string;
  /** "Riverside Shelter Gala · Paddle 142", when the hold could be found. */
  eyebrow?: string | null;
}

/** Frames 1 and 2: the window waiting on Fairhold or PayPal. */
export interface PaypalWindowWaiting {
  heading: string;
  detail: string;
  eyebrow: string | null;
  /** Frame 1 points out of the window, to PayPal; frame 2 holds the lock. */
  icon: "arrow" | "lock";
}

/** The approved window closes itself after this long (frame 3: "This window closes in 3 seconds."). */
export const APPROVED_CLOSE_SECONDS = 3;
/** Undrawn outcomes close this long after the message is sent, as before design/17. */
const CLOSE_DELAY_MS = 300;
/** If the window is still open by then, it was a full-page trip: go back to the auction. */
const RETURN_DELAY_MS = 1500;
/** Outcomes the guest has to read: the page stays up instead of closing or returning. */
const STAYS_OPEN: ReadonlySet<PaypalWindowOutcome> = new Set(["error", "refused"]);

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  // The URL carries PayPal's token and payer id; keep them out of Referer headers.
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
} as const;

export function paypalWindowResponse(page: PaypalWindowPage): Response {
  return new Response(renderPaypalWindowHtml(page), { status: page.status, headers: HEADERS });
}

/**
 * The outcome page once `work` settles. If it settles within `quickMs`, the answer is that page with
 * its own status. Otherwise frame 2 goes out at once, with status 200, and the outcome follows in
 * the same response and replaces it. `work` must not reject: map failures to a page first.
 */
export async function paypalWindowResponseWhenReady(
  work: Promise<PaypalWindowPage>,
  waiting: PaypalWindowWaiting,
  { quickMs = 400 }: { quickMs?: number } = {},
): Promise<Response> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), quickMs);
  });
  const first = await Promise.race([work, slow]);
  clearTimeout(timer);
  if (first !== null) return paypalWindowResponse(first);

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`${documentStart(waiting.heading)}${waitingFrame(waiting, "fh-waiting")}`));
      const page = await work;
      controller.enqueue(
        encoder.encode(`<style>#fh-waiting{display:none}</style>\n${outcomeFrame(page)}\n${outcomeScript(page)}\n</body>\n</html>\n`),
      );
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: HEADERS });
}

export function renderPaypalWindowHtml(page: PaypalWindowPage): string {
  return `${documentStart(page.heading)}${outcomeFrame(page)}\n${outcomeScript(page)}\n</body>\n</html>\n`;
}

/** Frame 1, served by /paypal/start while the server creates the order. */
export function renderPaypalStartHtml(waiting: PaypalWindowWaiting): string {
  return `${documentStart(waiting.heading)}${waitingFrame(waiting, null)}\n</body>\n</html>\n`;
}

export function paypalStartResponse(waiting: PaypalWindowWaiting): Response {
  return new Response(renderPaypalStartHtml(waiting), { status: 200, headers: HEADERS });
}

// ---------------------------------------------------------------------------------------------
// The frames

const ICON_ATTRS =
  'fill="none" stroke="#0B0B0C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const LOCK = '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>';
const MARK =
  '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="1.5" width="16" height="13.5" rx="4" fill="#DAF66E" stroke="#0B0B0C" stroke-width="1.5"/><rect x="10.75" y="14" width="2.5" height="8.5" rx="1.25" fill="#0B0B0C"/></svg>';
const RING =
  '<svg class="ring" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true"><circle cx="28" cy="28" r="26.75" stroke="#E6E6E1" stroke-width="2.5"/><path d="M28 1.25A26.75 26.75 0 0 1 54.75 28" stroke="#0B0B0C" stroke-width="2.5" stroke-linecap="round"/></svg>';

const ICONS = {
  arrow: `<span class="ic wait">${RING}<svg width="20" height="20" viewBox="0 0 24 24" ${ICON_ATTRS}><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg></span>`,
  lock: `<span class="ic wait">${RING}<svg width="20" height="20" viewBox="0 0 24 24" ${ICON_ATTRS}>${LOCK}</svg></span>`,
  ok: `<span class="ic ok"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#0B0B0C" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>`,
  no: `<span class="ic no"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3A3A3D" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></span>`,
} as const;

const FOOT_LOCK = `<svg width="15" height="15" viewBox="0 0 24 24" ${ICON_ATTRS.replace("#0B0B0C", "#3A3A3D")}>${LOCK}</svg>`;
const FOOT_RETURN = `<svg width="15" height="15" viewBox="0 0 24 24" ${ICON_ATTRS.replace("#0B0B0C", "#3A3A3D")}><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;

const HOLD_NOT_CHARGE = `${FOOT_LOCK}It’s a hold with PayPal, not a charge.`;

function frame(input: {
  id: string | null;
  icon: string;
  eyebrow: string | null | undefined;
  heading: string;
  detail: string;
  extra: string;
  foot: string;
}): string {
  const lines = input.detail
    .split("\n")
    .map((line, index, all) => {
      // The line the full-page trip has no use for: there is no window to close.
      const closeLine = index === all.length - 1 && line === "You can close this window." ? ' class="fh-close-line"' : "";
      return `<span${closeLine}>${escapeHtml(line)}</span>`;
    })
    .join("");
  return `<div class="pw"${input.id ? ` id="${input.id}"` : ""}>
<div class="brand">${MARK}Fairhold</div>
<main class="mid">
${input.icon}
${input.eyebrow ? `<p class="ey">${escapeHtml(input.eyebrow)}</p>` : ""}
<h1>${escapeHtml(input.heading)}</h1>
<p class="body">${lines}</p>
${input.extra}
</main>
<p class="foot">${input.foot}</p>
</div>`;
}

function waitingFrame(waiting: PaypalWindowWaiting, id: string | null): string {
  return frame({
    id,
    icon: ICONS[waiting.icon],
    eyebrow: waiting.eyebrow,
    heading: waiting.heading,
    detail: waiting.detail,
    extra: "",
    foot: HOLD_NOT_CHARGE,
  });
}

function outcomeFrame(page: PaypalWindowPage): string {
  const back = escapeHtml(page.backHref);
  switch (page.outcome) {
    case "approved":
      return frame({
        id: null,
        icon: ICONS.ok,
        eyebrow: page.eyebrow,
        heading: page.heading,
        detail: page.detail,
        extra: `<p class="aux" id="fh-aux">This window closes in ${APPROVED_CLOSE_SECONDS} seconds.</p>`,
        foot: `${FOOT_LOCK}You’re only charged if you win.`,
      });
    case "canceled":
      return frame({
        id: null,
        icon: ICONS.no,
        eyebrow: page.eyebrow,
        heading: page.heading,
        detail: page.detail,
        extra: `<button type="button" class="btn" id="fh-close">Close window</button><p class="aux" id="fh-aux" hidden></p>`,
        foot: `<span id="fh-foot">${FOOT_RETURN}You can try again from the gala tab.</span>`,
      });
    case "pending":
      return frame({
        id: null,
        icon: ICONS.lock,
        eyebrow: page.eyebrow,
        heading: page.heading,
        detail: page.detail,
        extra: `<a class="btn" href="${back}">Back to the auction</a>`,
        foot: HOLD_NOT_CHARGE,
      });
    case "declined":
    case "refused":
    case "error":
      return frame({
        id: null,
        icon: ICONS.no,
        eyebrow: page.eyebrow,
        heading: page.heading,
        detail: page.detail,
        extra: `<a class="btn" href="${back}">Back to the auction</a>`,
        foot: HOLD_NOT_CHARGE,
      });
  }
}

/**
 * Tells the opener, then leaves the way the outcome's frame says: approved closes after 3 seconds
 * with a countdown; canceled waits for "Close window"; the undrawn ones close at once, or stay up
 * for a page the guest has to read. In the gala tab itself (PAYPAL_IN_TAB_KEY) there is no window
 * to close, so it goes back to the auction.
 */
function outcomeScript(page: PaypalWindowPage): string {
  const message: PaypalWindowMessage = {
    type: PAYPAL_WINDOW_MESSAGE_TYPE,
    outcome: page.outcome,
    holdId: page.holdId,
  };
  const back = scriptJson(page.backHref);
  let leave = "";
  if (page.outcome === "approved") {
    leave = `
  var aux = document.getElementById("fh-aux");
  if (inTab) {
    hideCloseLine();
    if (aux) aux.textContent = "Taking you back to bid…";
    setTimeout(function () { window.location.replace(${back}); }, ${RETURN_DELAY_MS});
  } else {
    var left = ${APPROVED_CLOSE_SECONDS};
    var tick = setInterval(function () {
      left -= 1;
      if (left > 0 && aux) aux.textContent = "This window closes in " + left + (left === 1 ? " second." : " seconds.");
      if (left <= 0) {
        clearInterval(tick);
        window.close();
        setTimeout(function () { if (!window.closed) window.location.replace(${back}); }, ${CLOSE_DELAY_MS});
      }
    }, 1000);
  }`;
  } else if (page.outcome === "canceled") {
    leave = `
  var button = document.getElementById("fh-close");
  if (inTab) {
    hideCloseLine();
    if (button) button.hidden = true;
    var aux = document.getElementById("fh-aux");
    if (aux) { aux.hidden = false; aux.textContent = "Taking you back to try again…"; }
    var foot = document.getElementById("fh-foot");
    if (foot) foot.hidden = true;
    setTimeout(function () { window.location.replace(${back}); }, ${RETURN_DELAY_MS});
  } else if (button) {
    button.addEventListener("click", function () {
      window.close();
      setTimeout(function () { if (!window.closed) window.location.replace(${back}); }, ${CLOSE_DELAY_MS});
    });
  }`;
  } else if (!STAYS_OPEN.has(page.outcome)) {
    leave = `
  setTimeout(function () { window.close(); }, ${CLOSE_DELAY_MS});
  setTimeout(function () { if (!window.closed) window.location.replace(${back}); }, ${RETURN_DELAY_MS});`;
  }
  return `<script>
(function () {
  var message = ${scriptJson(message)};
  var inTab = false;
  try {
    inTab = message.holdId !== null && window.sessionStorage.getItem(${scriptJson(PAYPAL_IN_TAB_KEY)}) === message.holdId;
    if (inTab) window.sessionStorage.removeItem(${scriptJson(PAYPAL_IN_TAB_KEY)});
  } catch (error) {}
  function hideCloseLine() {
    var line = document.querySelector(".fh-close-line");
    if (line) line.hidden = true;
  }
  try {
    var channel = new BroadcastChannel(${scriptJson(PAYPAL_WINDOW_CHANNEL)});
    channel.postMessage(message);
    channel.close();
  } catch (error) {}
  try {
    if (window.opener && !window.opener.closed) window.opener.postMessage(message, window.location.origin);
  } catch (error) {}${leave}
})();
</script>`;
}

// ---------------------------------------------------------------------------------------------
// The document

/**
 * 17's window page: 08's brand lockup top left, one centred status block, 09's trust line at the
 * foot. Geist comes from /paypal/fonts, since these pages are outside the app's own stylesheet.
 */
const STYLE = `
@font-face{font-family:"Geist";src:url("/paypal/fonts/geist-sans.woff2") format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url("/paypal/fonts/geist-mono.woff2") format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#fff;color:#0B0B0C;font-family:"Geist",ui-sans-serif,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
.pw{position:relative;min-height:100%;min-height:100vh}
.brand{position:absolute;left:28px;top:24px;display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px}
.mid{position:absolute;left:0;right:0;top:172px;display:flex;flex-direction:column;align-items:center;text-align:center;padding:0 32px}
.ic{position:relative;width:56px;height:56px;border-radius:28px;display:flex;align-items:center;justify-content:center;flex:none}
.ic .ring{position:absolute;left:0;top:0;animation:fh-spin 1.1s linear infinite}
.ic.ok{background:#DAF66E;box-shadow:inset 0 0 0 1px #A9C93A}
.ic.no{background:#ECEBE7}
@keyframes fh-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ic .ring{animation:none}}
.ey{margin-top:24px;font-family:"Geist Mono",ui-monospace,monospace;font-size:11.5px;line-height:16px;letter-spacing:.09em;text-transform:uppercase;color:#6B6B70;white-space:nowrap}
h1{margin-top:8px;font-size:26px;line-height:32px;font-weight:600;letter-spacing:-.025em}
.body{margin-top:8px;font-size:15px;line-height:22px;color:#3A3A3D}
.body span{display:block}
.aux{margin-top:16px;font-size:13px;line-height:20px;color:#6B6B70}
.btn{margin-top:20px;height:40px;padding:0 18px;border-radius:12px;border:1px solid #E6E6E1;background:#fff;display:inline-flex;align-items:center;font:inherit;font-size:13.5px;font-weight:600;color:#0B0B0C;text-decoration:none;white-space:nowrap;cursor:pointer}
.foot{position:absolute;left:0;right:0;bottom:28px;display:flex;justify-content:center;align-items:center;gap:8px;font-size:12.5px;line-height:18px;color:#3A3A3D;white-space:nowrap}
.foot>span{display:flex;align-items:center;gap:8px}
.foot svg{flex:none}
`;

function documentStart(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Fairhold</title>
<style>${STYLE}</style>
</head>
<body>
`;
}

// ---------------------------------------------------------------------------------------------
// Where the window goes back to

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

/** "Riverside Shelter Gala · Paddle 142", the line over each frame's heading. */
export function windowEyebrow(context: { eventName: string; paddleNumber: number } | null): string | null {
  return context ? `${context.eventName} · Paddle ${context.paddleNumber}` : null;
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
