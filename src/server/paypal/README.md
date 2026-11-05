Owner area: payments. The payments interface with its sandbox (PayPal Orders v2 / Payments v2) and simulated versions, holds, raises and webhook verification.

- `payments.ts`: the `Payments` interface (create an AUTHORIZE order, authorize, read back, capture with final_capture, void, reauthorize), in integer cents.
- `runtime.ts`: `getPayments(hold.kind)` and the shared sandbox client, chosen from `PAYMENTS_MODE`.
- `sandbox-payments.ts`, `sandbox-client.ts`: the PayPal sandbox through @paypal/paypal-server-sdk, one cached OAuth token per process.
- `simulated-payments.ts`: deterministic, in-process, same rules and same errors; approval is instant.
- `errors.ts`: `PaypalError` with PayPal's issue code, HTTP status, debug_id and `retryable`.
- `idempotency.ts`: `paypalRequestId(scope, holdOrItemId, attempt?)`, the PayPal-Request-Id for every POST. Retries reuse it; only a deliberate new attempt passes `attempt`.
- `holds.ts`, `hold-store.ts`: the return and cancel ends of the PayPal window, idempotent, including the raise swap. The swap runs under the paddle row lock the engine takes before it reads a hold, and only when the new hold is larger than the one in place, covers the paddle's commitments (the engine's `COMMITMENTS_SQL`) and arrives before bidding ends (`holdSwapRefusal`). Otherwise the hold in place stays, the new one is stored as `replaced` with its authorization, and that authorization is voided.
- `webhooks.ts`, `webhook-event-store.ts`: verify-webhook-signature from the raw body, then store once by event id.
- `window-page.ts`: the unstyled page the PayPal window lands on; it notifies the opener (`src/app/paypal/window-message.ts`). Its back link and redirect only ever go to a page of the hold's own event (`backHrefFor`).

Conventions for callers: capture targets the current authorization id; void and reauthorize target the original one. A `PREVIOUSLY_VOIDED` answer to a void means it is already done.
