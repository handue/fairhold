Owner area: director. The demo gala's other bidders, its demo controls and the sweep. Simulated guests only: they bid as `bot`, hold `simulated` holds and never reach PayPal.

**The job runner** (`run.ts`, `task.ts`, `jobs.ts`). One `director_jobs` row is one bid the director may place. A job is claimed with `FOR UPDATE SKIP LOCKED` and runs in that transaction, through the engine's `createTransactionStore`, so its bid and its `done` commit together: a crash leaves no bid and the job queued, and a restart cannot place a bid twice. The row lock is the lease, so `running` is never stored. `task.ts` runs inside the engine tick (`src/instrumentation.ts`): an idle round is three small queries (about 3 ms with 25 demos running), and up to 3 workers run jobs without the tick awaiting them, so a job behind a lot lock never delays closing. A job that throws retries after 5 s and 10 s, then ends `failed` in `error_log`.

**Every bid goes through `placeDirectorBid` (`bids.ts`), then `placeBid` with source `bot`.** It refuses a paddle that is not simulated and anything over the lot's ceiling; the engine does the rest (open by the database clock, next minimum, the hold). A refusal ends the job with the reason on its row: `payload.result` says what every job did.

**Background bots** (`script.ts`). `createDemoEvent` plans each simulated guest's bot profile into dated `bot_bid` jobs, in the demo's own transaction. Each lot is played forward at the minimum raise, low bidders dropping out first. The seed is fixed (`seed.ts`), so every demo runs one script and a take can be repeated. Each job re-reads its lot, so a guest who joins only shortens that lot's contest.

**The rules** (`rules.ts`, pure, tested on a controllable clock):

| Who | When | What |
| --- | --- | --- |
| Background bots | Never on Chef's Table or Spa Day | So the golden path reads $320 and Glim's opening $90 |
| Background bots on Wine Tasting | Only after +10:30 | So Glim's opening bid there reads $220 |
| `rival_under_limit` | 20–40 s after Start bidding (`confirmed_at`) | Bids Glim's priority-1 lot to one raise under the limit: $360 under $380 |
| `rival_outbid` | 15–30 s after the first bid on the guest's second manual lot | Next minimum, or past the guest's own "Max…" |
| `rival_over_limit` | 40–55 s after the first rival, only while a destination has 90 s left | Limit plus one raise on the priority-1 lot: $400 over $380 |
| Everyone | Always | No director bid on Wine Tasting above $370 |

A destination is a backup on the guest's mandate, or Wine Tasting if they have none; on the default schedule that is the plan's "before +10:30". `reactions.ts` finds who needs a rival by reading the tables each round, so it has no cursor to lose. A reaction's job id is derived from its guest, so nobody gets one twice, even after a restart or on a later plan.

**Demo controls** (`controls.ts`, `POST /api/events/[slug]/demo/[action]`, organizer only, demo galas only): `close-next-lot`, `close-bidding`, `add-time`, `invite`, `reset`. They move close times under the engine's lock order and leave status, winners and bids to the engine (`closeDueLots`, `closeEvent`). Every move writes `schedule_changed` on the public channel. Reset starts the new gala and ends the old one in one transaction, so a refused Reset (503 at capacity, 409 while charging, 409 `demo_already_reset` on a second press) changes nothing; closing bidding and voiding follow, and the sweep finishes whatever they leave. The menu's look is design/18, which is not approved, so there is no page yet.

**The sweep** (`sweep.ts`, `POST /api/cron/sweep`, bearer `CRON_SECRET`): holds past `expires_at` become `expired`; every `replaced` hold with an authorization has its void retried; demos past `demo_expires_at` are retired, voided and only then deleted, and a demo with a void still owed waits for the next sweep; old rate-limit windows and `error_log` rows past 30 days go; the `sweep` heartbeat is written. Running it twice does nothing new. It does not reauthorize holds past their honor period.

**Holds** (`holds.ts`, `retire.ts`). Voids go through `getPayments(kind)`, on the original authorization id, with `paypalRequestId("void", holdId)`, so a retry replays the first answer. The paddle row is locked before a hold's status changes, and never across a PayPal call. Retiring a demo closes it through the engine, then moves `closed` to `settled` so `startSettlement` refuses it and a late approval reads bidding as ended; it waits while a settlement is `running`.

**Tests.** `npx vitest run tests/unit/director tests/integration/director`. `tests/integration/director/rivals.test.ts` runs the golden take on a real demo gala, from Start bidding through the rivals to Glim's move, with the clock in the test's hands.
