Owner area: opening a hold. `src/server/paypal` calls PayPal and finishes the window; this folder starts it and says what screen 09 shows.

- `create.ts`: `createHold({ paddleId, amountCents, origin, next })` inserts a `pending_approval` hold under the paddle row lock, creates the AUTHORIZE order with `paypalRequestId("create-order", holdId)`, stores `paypal_order_id` and returns the approval link. It throws an `ApiError`: 400 `amount_not_whole_dollars`, `amount_below_minimum`, `amount_above_maximum`; 409 `not_a_raise`, `below_commitments`, `bidding_ended`; 429 `rate_limited`; 502 `paypal_unavailable` (the hold is then `failed`). Pass the amount from the request only when the guest typed it; Glim's prepared raise passes the amount from its stored action.
- `rules.ts`: the amount rules with no server imports, so the page checks an amount as it is typed. `holdAmountIssue` mirrors `holdSwapRefusal` (`src/server/paypal/hold-store.ts`), which still decides at approval; `tests/unit/holds/rules.test.ts` keeps them in step.
- `view.ts`: `getPowerView` for `src/app/e/[slug]/power/page.tsx`.

Routes: `POST /api/holds/[slug]` opens a window and `GET /api/holds/[slug]/[holdId]` reads the status of the guest's own hold; the page polls it while a window is open.

Every status change writes a `hold` row on the paddle's channel. `createHold` adds one for `pending_approval`, with no amount, so the stream's `hold_raised` trigger (`src/server/plans/scan.ts`) ignores it.
