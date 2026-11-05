Owner area: engine. The deterministic bidding engine, the "code enforces" half of "AI proposes, code enforces".

**API** (`@/server/engine`): `placeBid`, `setMaxBid`, `createLimits` (a confirmed Glim plan; `removeLotIds` for plan edits), `removeLimit`, `pauseLimits` / `resumeLimits`, `closeDueLots`, `closeEvent`, `getBiddingPower` / `getCommitments`, and `startEngineTick` (called from `src/instrumentation.ts`). Refusals come back as values (`{ ok: false, refusal }`) with typed reasons and the numbers the UI shows: `lot_closed`, `not_open`, `below_minimum`, `no_hold`, `over_bidding_power`. Unknown ids and bad input throw `EngineError`.

**Rules**
- The invariant: for every paddle, the sum of its commitments never exceeds its authorized hold. Commitment per lot: on a closed lot, the amount won; otherwise the larger of the paddle's active limit max and its leading bid. `commitmentCents` (rules.ts) and `COMMITMENTS_SQL` (bidding-power.ts) are the one definition; reuse them instead of copying.
- A bid is refused at or after `closes_at` by the database clock, whether or not the tick has closed the lot.
- Limits (guest maxes and Glim's) answer by exactly the minimum raise, up to their max, until no limit can: the highest max first, the older limit on a tie. A limit left below the next minimum while someone else leads is exhausted, which frees its hold. Paused limits keep their hold reserved but do not bid.
- A new limit's max must reach the lot's next minimum, or the paddle's own bid when it already leads (`minimumLimitCents`), so a plan change can keep a lot that sits at its limit; Glim's allocator uses the same floor.

**Design.** Each action loads a locked snapshot through an `EngineStore` (pg-store.ts in production), decides everything in the pure `AuctionWorkspace` (workspace.ts), and writes one change set with its `event_log` rows and NOTIFY (`@/server/sse/notify`) in the same transaction. Lock order: lot rows by id, then paddle rows and their authorized holds by paddle id, then the event row, then the event_log ordering lock. Limit rows change only under their lot's lock. The paddle row guards bidding power: whatever changes a paddle's authorized hold (today the PayPal raise swap) locks that paddle row first, so the engine never decides against a hold that is being replaced.

**Tables.** The engine reads and writes the scope map's columns plus `bids.limit_id`, `bid_limits.paused_at` / `ended_at`, and unique `(lot_id, amount_cents)` on bids, all defined in `src/server/db/schema.ts` and migrated from `drizzle/` (the integration tests run on a freshly migrated database per file).

**Tests.** `npx vitest run tests/unit/engine tests/integration/engine`. `FAST_CHECK_RUNS` raises the property runs (2,000 on the in-memory store by default; a tenth of that on Postgres).
