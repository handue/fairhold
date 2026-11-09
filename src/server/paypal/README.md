Owner area: payments. The payments interface with its sandbox (PayPal Orders v2 / Payments v2) and simulated versions, holds, raises and webhook verification.

- `payments.ts`: the `Payments` interface (create an AUTHORIZE order, authorize, read back, capture with final_capture, void, reauthorize), in integer cents.
- `runtime.ts`: `getPayments(hold.kind)` and the shared sandbox client, chosen from `PAYMENTS_MODE`.
- `sandbox-payments.ts`, `sandbox-client.ts`: the PayPal sandbox through @paypal/paypal-server-sdk, one cached OAuth token per process.
- `simulated-payments.ts`: deterministic, in-process, same rules and same errors; approval is instant.
- `errors.ts`: `PaypalError` with PayPal's issue code, HTTP status, debug_id and `retryable`.
- `idempotency.ts`: `paypalRequestId(scope, holdOrItemId, attempt?)`, the PayPal-Request-Id for every POST. Retries reuse it; only a deliberate new attempt passes `attempt`.
- `holds.ts`, `hold-store.ts`: the return and cancel ends of the PayPal window, idempotent, including the raise swap. The swap runs under the paddle row lock the engine takes before it reads a hold, and only when the new hold is larger than the one in place, covers the paddle's commitments (the engine's `COMMITMENTS_SQL`) and arrives before bidding ends (`holdSwapRefusal`). Otherwise the hold in place stays, the new one is stored as `replaced` with its authorization, and that authorization is voided.
- `webhooks.ts`, `webhook-event-store.ts`: verify-webhook-signature from the raw body, with a request id that covers everything PayPal checks, then store once by event id.
- `window-page.ts`: the PayPal window's own pages (design/17): "Opening PayPal…" at /paypal/start, "Approving your hold…" while the return page waits on PayPal, then "Approved" (closes after 3 seconds) or "Canceled" ("Close window"). They notify the opener (`src/app/paypal/window-message.ts`); a trip made in the gala tab itself goes back to the auction. Its back link and redirect only ever go to a page of the hold's own event (`backHrefFor`); after a cancel or a decline, to that event's bidding power page (`retryHrefFor`).

A cancel changes a hold only with the order id PayPal appends to the URL. An authorization that lands on a hold already canceled, denied or failed is stored, as `replaced`, so its void can be retried by the sweep.

Opening the window, with its order, is `createHold` in `src/server/holds/create.ts`.

Conventions for callers: capture targets the current authorization id; void and reauthorize target the original one. A `PREVIOUSLY_VOIDED` answer to a void means it is already done.
