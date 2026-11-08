Owner area: screen 09, bidding power, and the PayPal window seen from the page that opens it. Ported from `mockups/09-web-bidding-power.html`, value for value; only its first state is approved.

- `PowerScreen`: the nav, the column and Glim's corner, from `getPowerView` (`src/server/holds/view.ts`).
- `PowerPanel`: the amount, the explainer and the Hold button. A paddle with a hold gets raise mode by itself.
- `HowTheHoldWorks`: the explainer. Every figure follows the amount chosen; the example win is 64% of it, as the approved $320 of $500.
- `useHoldWindow`: opens the window inside the click and follows it. News comes from the window (BroadcastChannel and postMessage, `src/app/paypal/window-message.ts`), the stream's `hold` rows, and polling `GET /api/holds/[slug]/[holdId]`, whichever arrives first. It refreshes the server's page when a hold lands, so the nav flips, and then goes back to bid.
- `hold-window.ts`: the popup and redirect decisions, with no React. A blocked window, or one that closed before the server answered, means a full-page redirect.
- `hold-flow.ts`: the button's states as a reducer, and all the plain copy of the undrawn states in one place.

**Links to it:** `powerHref(links, next)` in `power-href.ts`. `?next=` is where the guest goes after approving, checked by `backHrefFor`; `?amount=600` opens on an amount, and `?raise` (also `?raise=600`) says the same for links that mean a raise. An amount the rules refuse is ignored.

**Undrawn, plain until their images are approved:** "Other…" and its errors, waiting, canceled, failed (design/20 frames 7 to 11), raise mode (frame 12), the blank window's line and the redirect (design/17). Bidding closed and "at the top" have no image yet.
