# Day 1 status: Wed Nov 4, 2026

The Day 1 foundations are integrated and run locally from Postgres. The schema and its first migration exist, the seed writes the Riverside fixture, and 08 Lots and 05 Lot detail render it from the database. They match the pixels of the fixture-based captures already in this folder. All five findings of the Day 1 review are fixed (see Review fixes). Typecheck, lint, the production build and all 373 tests pass. Nothing has called PayPal or Claude yet: `.env.local` has no PayPal credentials and no Anthropic key, so the sandbox lifecycle run and the live Glim spike wait for them.

## What works

| Area | What runs | Where |
| --- | --- | --- |
| Data model | 21 tables, 20 enums, every table cascading from `events`; migration `0000_initial_schema` | `src/server/db/schema.ts`, `drizzle/` |
| Seed | `riverside-shelter-gala` at 8:58 PM (default), 9:15:40 PM or 9:30 PM; re-running replaces it | `scripts/seed.ts`, `src/server/demo/` |
| Demo galas | `createDemoEvent()`: 24 lots, 85 simulated guests with holds, a 25-minute schedule (not yet wired to a page) | `src/server/demo/createDemoEvent.ts` |
| Engine | `placeBid`, `setMaxBid`, `createLimits`, closing and the 1-second tick, with the hold invariant | `src/server/engine/` |
| PayPal | Orders v2 AUTHORIZE, capture with final_capture, void, reauthorize; sandbox and simulated; return, cancel and webhook routes | `src/server/paypal/`, `src/app/paypal/`, `src/app/api/paypal/webhook/` |
| Glim | claude-opus-5-5 proposal call, allocator, validator, amount guard; recorded mode without a key | `src/server/glim/` |
| Guest pages | 08 at `/e/riverside-shelter-gala`, 05 at `/e/riverside-shelter-gala/lots/7`, read from Postgres | `src/app/e/[slug]/`, `src/ui/` |
| Health | `GET /api/healthz` returns `{"ok":true}` when Postgres answers | `src/app/api/healthz/route.ts` |

### Seams wired today

- **08 and 05 read the seeded fixture from Postgres.** The pages were rendered with the clock frozen at 8:58 PM and captured at 2x. Both captures are pixel-identical to `ui-08-lots.png` and `ui-05-lot-detail.png`, which were rendered from the in-code fixture. Against the approved PNGs, 0.0065% (08) and 0.009% (05) of pixels differ by more than 48/255. On the built app, a bid placed through the engine showed up on both pages on reload.
- **The PayPal return flow and the engine agree on holds.** A hold the return page authorizes is the bidding power `placeBid` enforces. A raise authorizes the new total and voids the old hold, and there is exactly one authorized hold throughout. The swap takes the same paddle-row lock as the engine, and it refuses an approval that is not a raise, that would not cover the paddle's commitments, or that arrives after bidding ended. The hold in place then stays, and the new authorization is voided. A canceled window leaves no bidding power. Each change writes its `hold` row on the paddle's channel through the shared `appendEventLog`, inside the PayPal store's Drizzle transaction. Tested in `tests/integration/seams/hold-to-bid.test.ts`.
- **Glim plans with the engine's numbers.** `loadGlimState()` (`src/server/queries/glim-state.ts`) builds `GlimState` from the same reads as the guest pages, plus the engine's `getBiddingPower` and `getCommitments`. `COMMITMENTS_SQL` now also returns each lot's active limit (its owner and max), which Glim uses for `withoutGlimCents`. On the seeded fixture, the golden sentence gives Chef's Table $380 and Spa Day $120. A plan change that Glim validates is accepted by the engine's `createLimits`. Tested in `tests/integration/seams/glim-state.test.ts`.
- **One rule, many readers.** The demo's invariant check and replay, the lot card's next minimum and the demo integration test now call the engine's own `commitmentCents`, `nextMinimumCents` and `getBiddingPower`; they no longer use copies. The schema enums are checked against every area's status unions, and a test fails if `schema.ts` changes without a migration (`tests/unit/db/schema-contract.test.ts`).

### Decisions taken while integrating (please confirm)

1. **Commitment rule:** the engine's version stands: on an open lot, the larger of the active limit and the leading bid. The demo checks now use it. The seed's approved figures are unchanged.
2. **Floor for a lot the guest already leads:** Glim allowed a max equal to the guest's own winning bid, but the engine refused it. The engine now accepts the same floor (`minimumLimitCents`). Without that, any plan change that keeps a lot already at its limit was refused at confirm time.
3. **Bid history on 05:** sorted by amount, not `created_at`, since amounts strictly rise on a lot.
4. **Schema choices beyond the scope map:**
   - `glim_transcript` is its own append-only table, keyed by paddle and position, so two concurrent turns of one paddle collide instead of forking.
   - `chat_messages` gains `cache_read_tokens`, `cache_write_tokens` and `tokens_used`.
   - There is one settlement per event, because PayPal refuses a reused invoice id.
   - `lot_photos.data` is bytea, capped at 1 MiB.
   - `director_jobs` and `error_log` are added as the plan asks.
5. **The engine's and the seed's provisional table definitions and their test bridges are deleted.** Every integration test now runs on the real migrations.
6. **New environment variables:** `GLIM_DAILY_TOKEN_BUDGET` (default 1,000,000), `UI_FIXTURE` and `FREEZE_CLOCK_AT`. They now go through `src/server/lib/env.ts` and are listed in `.env.example`; production ignores the last two.
7. **Playwright** uses the installed Google Chrome for every spec, so nothing has to be downloaded.
8. **A refused raise approval needs no new hold status.** It is stored as `replaced`, by the hold in place, with its authorization, until PayPal confirms the void; then it is `voided`. An approval for the same amount as the current hold also counts as "not a raise".
9. **New PayPal window outcome `refused`:** the window stays open so the guest can read why the bidding power did not change. Its three lines in `src/app/paypal/return/route.ts` are unapproved, like the rest of that unstyled page.
10. **Amount guard:** a bare number of two or more digits always counts as a dollar figure, not only when the reply also has one marked with `$`. That keeps the streamed text from ever running ahead of the guard. Clock times, lot and paddle numbers, counts ("12 bids", "19 min", "64%") and ordinals are exempt. Number words from "ten" up count as amounts unless a count or clock word follows them ("ten minutes" passes; "nine hundred" does not).
11. **The PayPal window's back link** only returns to pages of the hold's own event (`/e/<slug>/…`). When the hold is unknown, it links to the home page.
12. **Lock order:** paddle rows now come before their holds (`src/server/engine/store.ts`). Whatever changes a paddle's authorized hold must lock the paddle row first.

## Review fixes (Nov 4)

- **A smaller approved hold could replace a larger one (high).** Approving an older, smaller raise window after a larger one, or any window after bidding closed, swapped the paddle's hold without a check. `markAuthorized` (`src/server/paypal/hold-store.ts`) now locks the paddle row, the same row the engine locks, then the current hold and the event row (FOR SHARE). It reads the engine's `COMMITMENTS_SQL`. `holdSwapRefusal` lets the new hold become bidding power only if it is larger than the hold in place, covers the commitments, and the event has not ended. Otherwise the hold in place stays and the new authorization is voided (`completeHoldApproval`, `src/server/paypal/holds.ts`). The return page explains which case applied.
- **Open redirect on the PayPal return and cancel pages (medium).** `backHrefFor` (`src/server/paypal/window-page.ts`) now checks the path after URL parsing has resolved it, and accepts only `/e/<slug>` and `/e/<slug>/…` of the hold's own event. `/.//evil.example`, `/x/..//evil.example`, `/%2e//evil.example` and `/./\evil.example` all fall back to the event page.
- **A limit lost its answer when its holder's hold was swapped mid-bid (medium).** `lockAuthorizedHolds` (`src/server/engine/pg-store.ts`) now locks the involved paddle rows before their holds. When a paddle comes back without a hold, it reads again, until a read finds nothing new. That covers every involved paddle, not only the bidder. A swap written without the paddle lock still cannot make a limit look hold-less.
- **Amount guard gaps (medium).** `src/server/glim/money.ts` first folds the text: NFKC, then the digits of any script to ASCII, and invisible format characters are removed. It then reads `$`, `US$` and `USD` with any spacing, a trailing `$`, "dollars", "US dollars" and "bucks", bare figures, and spelled-out amounts without a currency word (see decision 10). All 8 shapes from the review are now replaced by the template.
- **A bid that waited on the lot lock past closes_at was accepted (low).** `lockLots` (`src/server/engine/pg-store.ts`) now reads `clock_timestamp() >= closes_at` in a second statement, once every lot lock is held. The locking statement computes its columns before it waits, so neither `now()` nor a value read there could refuse a bid that queued behind the lot until after closing. A bid's `created_at` is still its transaction's start, at most the 5-second lock timeout before the decision.
- **PayPal errors kept the SDK request, Authorization header included (review note).** `PaypalError` (`src/server/paypal/errors.ts`) now keeps only the name, message, code and stack of each error in its cause chain, so printing or storing one at any depth cannot leak the bearer token or the client secret. Test: "keeps no credentials in its errors" in `tests/unit/paypal/sandbox-payments.test.ts`.

Each finding's failing review test now passes (`tests/integration/review/hold-swap-invariant.test.ts`, `raise-during-rival-bid.test.ts`, `bid-after-close.test.ts`, `tests/unit/review/paypal-window-open-redirect.test.ts`, `glim-amount-guard-gaps.test.ts`). New regression tests:
- on Postgres, the closed-event and commitments refusals (the review test covers the stale raise), and a bid in flight during a raise: during a real approval, during a swap that holds the paddle row, and during one that skips it (`tests/integration/seams/hold-to-bid.test.ts`);
- the refusals and a failed void in the in-memory store (`tests/unit/paypal/holds.test.ts`);
- the refused page (`tests/unit/paypal/routes.test.ts`, `window-page.test.ts`);
- the folded, bare and spelled-out figures, and pausing the stream before a bare one (`tests/unit/glim/amountGuard.test.ts`).

A mutation check confirmed the paddle-lock test: without the engine's paddle lock it fails, as intended.

## Test counts

`npm test`: 47 files, 373 tests, about 17 s, all passing.

| Suite | Files | Tests |
| --- | --- | --- |
| Glim (unit) | 9 | 91 |
| PayPal (unit) | 8 | 93 |
| Demo seed (unit) | 4 | 47 |
| Engine (unit) | 4 | 38 |
| Read models and UI (unit) | 5 | 35 |
| Env and schema contract (unit) | 2 | 18 |
| Review findings (unit) | 2 | 13 |
| Engine on Postgres (integration) | 6 | 17 |
| Seams (integration) | 2 | 12 |
| Review findings (integration) | 3 | 3 |
| Demo on Postgres (integration) | 1 | 4 |
| Test database (integration) | 1 | 2 |

Also run today (the first three again after the review fixes):
- **Property tests:** `FAST_CHECK_RUNS=10000` on the engine's property tests (10,000 in-memory runs and 1,000 on Postgres). Both pass.
- **Simulated PayPal lifecycle:** `npm run paypal:lifecycle -- --simulated` passes 25 of 25 checks.
- **Glim spike:** `npm run glim:spike` (recorded) prints "OK: Chef's Table $380 and Spa Day $120".
- **Browser checks:** `npx playwright test` against the Postgres-backed dev server: 10 passed (guest pages 7, fidelity 2, health 1). Not rerun after the fixes, which leave 08 and 05 unchanged.
- **Cost of the paddle lock:** the Postgres property test took 8 s with it and 8 s without it, in three alternating rounds.

## Waiting for your keys

Paste the values into `.env.local` yourself; never into chat.

**PayPal sandbox** (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`):

```sh
npm run paypal:lifecycle -- --preflight   # no approvals: credentials, order creation, replay
npm run paypal:lifecycle                  # approve 6 sandbox windows as buyer-1
```

The run writes `docs/paypal-lifecycle.md`:
- A is captured for $320 with final_capture.
- B is voided.
- C is raised from $500 to $700.
- D and E stay open for the Nov 8 reauthorize test.
- It also runs a replayed capture and a declined capture.

The CONTINUE and PAY_NOW approval-page screenshots are still taken by hand. To run the app itself on the sandbox, set `PAYMENTS_MODE=sandbox`.

**Anthropic** (`ANTHROPIC_API_KEY`):

```sh
GLIM_MODE=live npm run glim:spike         # must print Chef's Table $380 and Spa Day $120
```

**Later steps:** `PAYPAL_WEBHOOK_ID` comes with the webhook on Nov 5 (step 7). The hosted check needs the Render Blueprint applied (step 5), then one `npm run db:seed` against the Render database.

## Known gaps

- **Not built yet (Day 2 and later, by plan):**
  - home and join, sessions and organizer rights;
  - `createHold` and the 09 window;
  - the live stream (`/api/stream` answers 501);
  - the cron sweep (`/api/cron/sweep` answers 501) and the 6-hour demo cleanup;
  - the director bots and demo controls;
  - demo rate limits (5 per IP per hour, 25 active);
  - chat persistence, settlement, receipts, the projector and the control room.
- **Review notes for later days** (no failing case today):
  - `paypalRequestId("reauthorize", holdId)` gives every reauthorization round of a hold the same key, so a second round would replay the first one's answer. Day 5 should pass the round as the attempt number.
  - The verify-webhook-signature request id comes only from the transmission id the caller sends. If PayPal honors that header there, the key should also hash the body.
  - Until sessions land (Day 2), `?paddle=` lets anyone view any paddle's bidding power.
- **Hold raises:**
  - The swap now refuses any approval that is not a raise, would not cover the commitments, or arrives after bidding ended. The invariant therefore also holds outside the engine.
  - `createHold` (Day 2) should still refuse to open such a window, so a guest never approves a hold that is released at once.
  - The Day 5 backstop trigger must also fire on `holds` updates (status and amount), not only on bids and limits.
- **Rules for later hold writers:**
  - Capture, void, expiry and reauthorization (Days 2 to 5) must lock the paddle row before they change an authorized hold.
  - `startSettlement` must move the event to `settling` before it reads the holds. The swap's FOR SHARE lock on the event row is what keeps a late approval out of a running settlement.
  - The cron sweep must retry the void of every `replaced` hold that still has an authorization: a refused approval, or a raised one whose void failed.
- **Amount guard limits:**
  - Number words spelled with look-alike letters from other scripts are not caught.
  - A bare number in a lot title that Glim repeats ("Cabin 12") replaces the reply with the template.
- **Writes still to build:** `glim_actions` rows and `bids.glim_action_id` for live Glim bids belong to `confirmPlan` (Day 3). Today the engine records Glim's limit facts in `event_log`.
- **The fixture keeps the gala's real times** (Saturday, Nov 7, 2026, 9:05 to 9:30 PM Pacific):
  - The approved countdowns need `FREEZE_CLOCK_AT`, which works only under `npm run dev`. The built app shows real countdowns.
  - With `ENGINE_ENABLED=true` after Nov 7, the engine closes the fixture's lots; reseed to restore them.
- **Unknown event slugs** show the not-found page but answer HTTP 200, because the page streams. A link crawler on Day 6 has to check the page text, not only the status.
- **Lot drawings:** only 8 lots have them. Five more exist in the rejected 13b mockup on a different ground line; using them is your call.
- **Copy and recordings:**
  - Glim's unapproved lines in `src/server/glim/copy.ts` and the card text "Opening bid $X" wait for Sheet B.
  - Glim has 3 of about 20 recorded prompts for CI.
- **Test coverage:**
  - The Postgres property test runs 200 scenarios by default to keep CI fast; `FAST_CHECK_RUNS` raises it.
  - End-to-end tests are not in CI yet.
- **Two timing checks failed under heavy machine load** (load average near 20 from other work); both passed on every rerun:
  - `tests/integration/engine/concurrency.test.ts` checks that its waves set off more than 10 proxy bids. It counted 5 in 2 of the first 13 full runs. It then passed in all 14 runs of a comparison with and without the new paddle lock (7 each), and in every later run.
  - The count depends only on interleaving. Replayed one operation at a time on the in-memory store, the waves give 25 proxy bids in the test's own order, 62 with every max first and 3 with every manual bid first.
  - No deadlock, lock timeout or invariant failure appeared in that test's own checks or in the Postgres log.
  - `tests/unit/db/schema-contract.test.ts` runs drizzle-kit's diff, which twice exceeded the 5-second unit timeout.
  - Both checks are now sturdier: the concurrency test asks only that some proxy bids fired, and the diff has 30 seconds.
- **First CI run (Nov 4):** all 373 tests passed, but 16 unhandled 57P01 errors failed the run. `Pool.end()` resolves before its connections are gone, and the test database was force-dropped while the concurrency test's 50 connections were still closing (locally, up to 28 were still connected right after `end()`). The drop in `tests/helpers/database.ts` now waits up to 5 seconds for the database's connections to leave; locally that wait takes 3 to 5 ms.

## Run it locally

```sh
npm install
npm run db:start          # Postgres 16 on port 54329, data in .pgdata/ (left running)
npm run db:migrate
npm run db:seed           # prints the instant to freeze the clock at
npm run typecheck && npm run lint && npm test
npm run build

# The approved look, from Postgres:
FREEZE_CLOCK_AT=2026-11-08T04:58:00Z npm run dev -- -p 3456
#   http://localhost:3456/e/riverside-shelter-gala
#   http://localhost:3456/e/riverside-shelter-gala/lots/7
PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test

# The built app:
npm start                 # http://localhost:3000
curl http://localhost:3000/api/healthz
```

Other seed moments:
- `npm run db:seed -- --moment=paddle` (9:15:40 PM, for 10 and 14);
- `npm run db:seed -- --moment=closed` (9:30 PM, for 12).

Use `localhost` rather than `127.0.0.1`, because Next dev blocks dev resources on `127.0.0.1`.

**After a schema change:** run `npm run db:generate -- --name <change>`, then `npm run db:migrate`.
