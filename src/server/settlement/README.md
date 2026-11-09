Owner area: settlement. The checks before charging, the capture-or-void queue, receipt snapshots, and applying PayPal's webhooks. Import from `@/server/settlement`; `types.ts` is safe for client components.

**The flow.** `runSettlementChecks` → `startSettlement` → `processSettlementQueue` → `finishDueSettlements`.

- **Checks** (`checks.ts`): every winner's total within an authorized hold; every bid Glim placed within its limit and the largest hold the paddle had when it was placed, read from the bids themselves, which blocks only for a winner; and a GET to PayPal for each real hold: CREATED, unexpired, and large enough. A winner's hold past `honor_until` on a non-demo event is reauthorized first (`reauthorize.ts`). A real hold that won nothing is only noted, since it gets released either way. Simulated holds have nothing to ask about.
- **Start** (`start.ts`): idempotent. The checks run first, with no locks. Then one transaction: paddle rows, the event row, status `settling`, and only then the holds are read. `plan.ts` makes one item per authorized hold, and refuses a total over its hold, which rolls everything back.
- **Queue** (`queue.ts`): the state is `settlement_items`, so it survives a restart. A claim (`FOR UPDATE SKIP LOCKED`) stamps a 2-minute lease in `next_attempt_at`; a worker that died comes back when it runs out. PayPal is called between transactions, never inside one. Largest charges first.
  - `capture`: the won total on the current authorization id, `final_capture`, invoice `FH-<event>-<paddle>`. Then a read-back: on `PARTIALLY_CAPTURED` the rest is voided on the original id. The item stays open until the read-back is done, so a crash still gets it; the charge stands whatever it finds, and a problem there is a note in `error_code` on a succeeded row.
  - `void`: the original id, for a real hold that won nothing. `PREVIOUSLY_VOIDED` is done.
  - `simulate`: the database only. Payments is never called.
- **Finish**: `done` and the event `settled` when every item succeeded; otherwise `done_with_errors`, with the event still `settling` until a retry or a webhook brings the last rows through. Then `voidReplacedHolds` retries any replaced hold still holding an authorization.
- **Writes** (`store.ts`): each is one transaction, paddle row first, then the hold, the item, the settlement, the event, and the `event_log` lock last, extending the engine's order.

**Idempotency.** `paypal_request_id` holds the id the next call must send. Retries of an undecided try reuse it, so PayPal replays its answer. Only a 4xx refusal is a final answer (`isFinalAnswer`): the row fails and the stored id moves to the next attempt, because reusing it would replay the refusal. A timeout, a 5xx or an answer this app could not read keeps the id, even through an organizer's retry, because the first try may have charged. The invoice id never changes, so a charge that did go through refuses a second one.

**Retry** (`retrySettlementItem`) needs the event still `settling`, read under the item, settlement and event locks. A retired demo is `settled`, its holds are being released, and a capture would race that.

**`attempts`** counts tries. An organizer's retry jumps it to the next multiple of `TRIES_PER_ATTEMPT` (`plan.ts`), so the one column gives both the attempt number and the tries it has used.

**Webhooks** (`webhook.ts`). The route stores a verified event once (`src/server/paypal/webhooks.ts`) and starts applying it; the tick takes what that left. It only moves forward: a charge on record stays on record, and `PAYMENT.CAPTURE.COMPLETED` can bring a failed or waiting row forward. A capture `PENDING` leaves the hold authorized and writes no receipt until `COMPLETED`. `REFUNDED` and `REVERSED` are only logged.

**Receipts** (`receipt.ts`): written once, in the transaction that stores the charge. `lines` holds the won lots and the lots bid on but not won (`ReceiptLine`), `glim_recap` the counts behind 11's recap (`ReceiptGlimRecap`). A simulated winner gets one too, with no capture id. A lot with no estimated value yields no deductible.

**Reads** (`ledger.ts`): `getLedgerView(slug)` is 12's data, with no PayPal call. It also carries the server's clock (12's "Closes in" countdown), the receipt and released counts for design/24 §3, and the display-only "Glim stayed inside every guest's rules" row (design/21 V6, C4): executed autopilot actions in `glim_actions` and the bids tied to them, checked against each plan's mandate: the lots it allows (a lot the guest skipped before the decision does not count), each lot's cap and limit, the maximums' sum against the named budget ("Never past $500 in all", except a decision that only lowers or drops, R9), and a raise against that budget. That row never blocks a charge; `checks.ts` is unchanged. `insights.ts` (`getInsightsView(slug)`) is design/28's Insights: raised through the evening, lots sold, bids, winners, limits kept, hold utilization and the top lots, read-only, from the same tables. **Access** (`access.ts`): `requireControlRoom`, the same rule as the page.

**Moving it** (`runner.ts`): routes call `kickSettlementQueue`, and `createSettlementTickTask` keeps it going from the engine tick. Neither waits, so a PayPal call never delays lot closing.

**Tests.** `npx vitest run tests/unit/settlement tests/unit/organizer tests/integration/settlement`, and `tests/e2e/control-room.spec.ts` in a browser. `tests/integration/settlement/support.ts` has `paypalWorld`, PayPal's rules at the wire on top of `tests/unit/paypal/fake-paypal.ts`.
