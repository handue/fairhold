# Day 2 status: Sun Nov 8, 2026

The guest path works end to end, locally and keyless. A demo gala, a hold, live bids, Glim's plan, Start bidding, the director's rivals, closing, the checks, the charge, the voids and the receipt snapshot all run through the real routes on Postgres. With the autopilot's switch on, which only tests do, the rival's $400 moves the $380 left to Wine Tasting with a $220 bid, and the guest's spending never passes $500.

Nothing has run on the hosted URL or against real PayPal in the app. The autopilot's switch stays off in the shipped code until V1 (design/21) is approved. 10, 11 and 14 are still Day 1 stubs. Typecheck, lint, the production build and all 1,370 tests pass. All 14 findings of the second review wave are fixed (see Review fixes).

## What works

| Area | What runs | Where |
| --- | --- | --- |
| Entry | Demo gala from the home page, join by link, sessions, organizer rights for one event, both demo limits (plain stand-ins for design/16 and 16b) | `src/app/page.tsx`, `src/app/e/[slug]/join/`, `src/server/sessions/`, `src/server/demo/start.ts` |
| 09 bidding power | `createHold`, popup with redirect fallback, return and cancel pages, raise, the nav updating live | `src/server/holds/`, `src/app/api/holds/[slug]/`, `src/ui/power/` |
| Live layer | `/api/stream` with replay and heartbeats, polling fallback, the fold over stream rows | `src/server/sse/`, `src/ui/live/`, `src/server/queries/live-records.ts` |
| 08 and 05 | Live bids, "Max…", favorites, share, refusals with their numbers | `src/ui/catalog/`, `src/ui/lot/`, `src/app/api/events/[slug]/lots/[number]/` |
| 07 Glim | Chat persistence, plan card, Start bidding, event cards, Skip, Pause, Resume, the caps, the raise offer | `src/server/chat/`, `src/app/api/glim/[slug]/`, `src/ui/glim/` |
| Director | Job runner in the tick, 65 background bids per demo, three reactive rivals, demo control routes, the sweep | `src/server/director/`, `src/app/api/events/[slug]/demo/[action]/`, `src/app/api/cron/sweep/` |
| Settlement and 12 | Checks, the restart-safe capture and void queue, receipt snapshots, webhook apply, the ledger on AG Grid Community | `src/server/settlement/`, `src/app/api/events/[slug]/settlement/`, `src/ui/organizer/` |
| Autopilot | Server built Nov 7; armed only with the switch on | `src/server/plans/`, `src/server/glim/autopilot/`, `src/server/chat/switch.ts` |

### Seams wired today

- **The whole path, through the route handlers:** `tests/integration/seams/golden-path.test.ts`, on simulated payments and recorded Glim. Each figure below is asserted.
  - **Hold:** `POST /api/demo`, `POST /api/holds/[slug]` for $500 and the return page. The nav reads $500 / $500.
  - **Bid:** a $320 bid leaves $180 / $500, and it reaches a second guest's open stream. A bid over what is left gets 409 `over_bidding_power`.
  - **Plan:** the golden sentence gives $380 / $120, and Start bidding places $90 on Spa Day.
  - **Rivals:** the $360 is answered at $380, and the $400 passes the limit.
  - **Autopilot:** the tick's own tasks, in `src/instrumentation.ts`'s order, move the money with no tap.
  - **Close and charge:** close, checks, charge. Jamie's $310 is captured with $190 released. Kai's hold is voided, and so is the old authorization from his raise. The 85 simulated guests settle with no PayPal call.
  - **Receipt:** the snapshot reads $310 paid, with Wine Tasting and Spa Day won by Glim and Chef's Table not won.
- **The same test at the top end:** the bots push Wine Tasting toward their $370 ceiling, Glim answers within $380, spending is checked every minute of the demo clock, and the capture equals the won total, under $500.
- **The same test as the app ships today:** with the switch off there is no mandate and nothing armed. The rival's $400 moves nothing, and the charge is $90 for Spa Day.
- **On the built app, on the real tick and the real clock (curl, switch off):**
  - The rivals' cards arrived within 76 s of Start bidding.
  - Close, checks and charge gave `settled`, with paddle 142 captured for $90 and the invited guest voided. The sweep ran clean.
  - Session and access answers: 401 with no session, 403 for a guest, 403 cross-site, 401 on the sweep without its bearer.
- **In real browsers on the real tick (`tests/e2e/golden-path.spec.ts`):** home page, the nav's pill, 09, the window, a bid a second browser sees, a refusal, the golden sentence, Start bidding, both rival cards in the open panel, then 12 charging. It took 1.5 minutes. Close is the one step that uses a route, because its control is design/18.
- **The nav's pill now links to 09** (`src/ui/EventNav.tsx`), so 08 has a way to set bidding power before a refusal. It looks the same: 08 and 05 are byte-identical to their captures.

A mutation check on `golden-path.test.ts` caught 7 of 7:
- capturing the whole hold
- not voiding non-winners
- every viewer reading every paddle's rows
- no overspend check
- no mandate
- a rival past the limit instead of under it
- a guest able to close bidding

An eighth mutant survived. It disabled `responseBlocker`, the engine's secondary check on proxy answers, which never trips on this path. The primary check, `overspend`, is the one in the list above.

### Fidelity

| Screen | Against | Pixels over 48/255 | Share |
| --- | --- | --- | --- |
| 08 | `docs/status/ui-08-lots.png` | 0 (byte-identical) | |
| 05 | `docs/status/ui-05-lot-detail.png` | 0 (byte-identical) | |
| 08 | `mockups/08-web-lots.png` | 336 of 5,184,000 | 0.0065% |
| 09 | `mockups/09-web-bidding-power.png` | 328 of 5,184,000 | 0.0063% |
| 12 | `mockups/12-web-control-room.png` | 326 of 5,184,000 | 0.0063% |

- In 08, 09 and 12, 326 of those pixels fall in the bottom 30 rows, which is where the track reports place the mockup's rounded window corners.
- 07 passed its spec, which compares against the approved PNG when `mockups/` is present. The glim track measured 36 of 1,126,400 pixels (0.003%) on its own run.
- New captures are in this folder: `ui-07-panel.png`, `ui-09-power.png`, `ui-12-control-room.png`.

## The lead's own walkthrough (Nov 8, 3:40 to 3:52 PM)

On the production build (`next start`), a fresh database, the real tick, simulated payments and **live Claude**, in the app's browser and in headless Chrome:

- **The path:** home, the $500 hold in its window, a $320 bid (the nav moved to $180 / $500), the golden sentence, Start bidding, the rivals, close through the route, the checks, the charge.
- **Glim on the live model, through the app, for the first time:** the golden sentence gave Chef's Table $380 and Spa Day $120, in about 10 s. Start bidding placed $90 on Spa Day. The rival's $360 was answered at $380 inside about 80 s, and the $400 passed the limit. With the switch off, nothing moved.
- **The money:** Jamie's $500 hold captured $90 and released $410. The receipt reads $90 paid and $20 deductible on Spa Day's $70 estimated value, with Chef's Table not won. No row in `error_log`, and no console errors.

It found three defects the tests had not, all fixed with tests:

| Defect | Fix | Test |
| --- | --- | --- |
| 12 could read "21 winners charged" over rows still "Queued", and polling stops once charged. The ledger read rows and settlement at the same time, so simulated guests, who settle in under 100 ms, could land between them | The settlement is read first, so a "done" can never be ahead of its rows | `ledger.test.ts`; putting the old order back fails it |
| After "Close bidding now" a guest's nav read "Closed at 4:07 PM" at 3:45 PM, the schedule and not the close | The guest read takes `closed_at` first, and the fold takes the `event_closed` row's time when that is earlier | `live-records.test.ts`, `live-fold.test.ts` |
| "Glim bid for 1 bidder; 1 of them won lots", which is what every judge's demo would show | Singular wording for one bidder | `ledger-model.test.ts` |

A blank ledger for a few seconds in the app's browser was the hidden pane, not the app: in headless Chrome the first row shows after about 0.8 s.

**Not covered by this walk:** a real sandbox window, the hosted URL, Safari, and the autopilot on live Claude through the app (its switch is off; the server's live spike passed on Nov 7).

## Decisions to confirm

**From integrating**
1. **Closing and the control room in a browser.** There is no button or link until design/18 is approved. 12 is reached at `/e/<slug>/organizer`, and bidding ends on its 25-minute schedule or through the route. One plain "Close bidding now" on 12's live state would make the path walkable sooner; I did not add it, since design/18 is unapproved.
2. **The sweep does not reauthorize.** The plan's cron lists it, but no real hold exists outside a demo, demos never get that old, and settlement's checks reauthorize at charge time. `reauthorizeHold` is ready if you want the loop.
3. **Abandoned windows stay `pending_approval`.** Nothing reads them and they are deleted with the demo. A late approval is still judged by the swap's rules.
4. **`voidReplacedHolds` and the sweep's own void loop stay separate.** They send the same request id, so they cannot void twice. I corrected the docstring that said the sweep calls it.
5. **Routes `/api/holds/[slug]` and `/api/glim/[slug]`** stay as built, beside `/api/events/[slug]/...`. Moving them is small.

**Holds**
6. A blocked popup redirects the tab at once, as the build plan says; design/17 frame 5 draws a "Continue to PayPal in this tab" button instead.
7. A popup that reads closed is not treated as closed. The page gives the button back and keeps listening.
8. 20 windows per paddle per 10 minutes.
9. 09's explainer uses the first open dining lot, with the win at 64% of the hold in whole dollars.
10. After approval the tab waits 1.2 s so the nav's flip shows, then returns to bid.
11. "Bidding closed" on 09 uses the database clock, not `FREEZE_CLOCK_AT`.
12. `createHold` writes a `pending_approval` stream row with no amount; `hold_raised` ignores it.

**Live**
13. Tiles keep their place while a page is open and re-rank on the next load. A lot that starts winning behind "Show 16 more" stays hidden until then.
14. Won lots come first among closed lots on 08.
15. A preset pick stands while it is offered; otherwise the card falls to the next minimum, never higher.
16. New private row `favorite_changed`, so other tabs follow the heart.
17. 60 lot actions per paddle per minute; 20 streams per client address and 1,000 per process, then 429 or 503 and polling.
18. A new connection replays the event's last 100 rows; further back, it refreshes the page.
19. Visitors with no session get public rows of an event whose slug they know, which the projector needs.
20. **The nav and a refusal can show different figures.** The nav uses hold minus leading bids and won lots; a refusal also reserves limits. A guest may see $180 in the nav and "you have $80 left". Is that acceptable?
21. After a capture or void the nav reads "Not set", matching a fresh read.

**Glim**
22. No mandate while the switch is off: the guest has not seen the rules, so there is no consent to record.
23. The templater skips a listed limit's opening bid and that limit being outbid in the same transaction, per spec §6.2. Later raises on it still get cards.
24. A new card supersedes one still waiting.
25. Cap, empty and too-long messages are not stored; the panel shows them for that session.
26. "Chef's Table Dinner for Four" shows as 07's "Chef's Table Dinner"; "Skip the spa" is the approved label, other lots read "Skip <short title>".
27. The "+" stays as approved; design/22 proposes removing it.
28. Won or lost cards also appear for hand-bid lots, but only after the guest's first plan.
29. Raises don't set `bids.glim_action_id`; nothing reads that link today.
30. A turn keeps running after the browser leaves.
31. Each turn holds one connection outside the pool, at most 16 per process. A paddle's second message waits up to 75 s, then gets `glim_busy`; a third gets it at once. Brakes: 30 messages and 60 button presses per minute per paddle.

**Director**
32. Rivals follow Glim's priority-1 lot, not only Lot 07. Each real guest gets each rival once.
33. The over-limit check uses the guest's backups, or Lot 09 if there are none.
34. `rival_outbid` goes past a guest's own "Max…", so the lot still flips.
35. Lots 07 and 12 get no background bids, so with no guest they stay frozen.
36. Controls write `lots.closes_at` directly, under the engine's lock order: a narrow exception to "the engine is the only writer of lot state".
37. Retiring a demo moves `closed` to `settled` with no settlement row. An invited guest sees it as settled with no charges.
38. Reset starts the new gala and ends the old one in one transaction, so a refusal changes nothing: 503 at capacity, 409 `settlement_running` while charging, 409 `demo_already_reset` on a second press. It then waits up to 8 s for voids and leaves the old gala to the next sweep. It is limited to 20 per client per hour. The old gala's organizer session goes in the same transaction, so its cookie answers 401; invited guests keep theirs and see it closed.
39. Add 10 minutes stretches each lot's queued bids, never reopens a lot past its close, and is refused within 30 minutes of the 6-hour limit.
40. PayPal's `INVALID_RESOURCE_ID` or `RESOURCE_NOT_FOUND` on a void counts as nothing left to void, and is logged.

**Settlement**
41. A failed check stops the whole charge. Only a winner's invalid hold, or a winner's Glim bid past its limit or hold, counts. A problem on anyone else is still listed on the check, without blocking.
42. **A sold lot with no estimated value does not block charging**, and yields $0 deductible. The scope map said to block, but the fixture sells Lot 23 with none, which would make the approved screen unchargeable.
43. Only a 4xx rotates the PayPal-Request-Id. After a timeout or 5xx the id stays, even through an organizer's retry, because the first try may have charged. The invoice id never changes.
44. A `PENDING` capture leaves the hold authorized with no receipt until `COMPLETED`; a webhook or "Ask PayPal again" resolves it.
45. The event stays `settling` until every row succeeds.
46. 5 tries per attempt, backoff 2/8/30/120 s, 2-minute lease.
47. Receipts go to every winner, simulated ones included, with no capture id. Non-winners get none.
48. Reauthorization is for the full hold; the round is the number of honor periods elapsed, so a later round is a new request.
49. Two lots keep their full titles in the ledger, to reproduce the approved cells.
50. Outside production, the fixture's control room also accepts POSTs without a session, so design checks can click.
51. 30 per minute per event on checks and on start.

**From the second review's fixes**
52. **The seeded event takes no guests in production. Please decide.** Join and `createHold` answer 403 `event_view_only` on any non-demo event there, and it stays viewable. Nothing can close, charge or release a seeded event in production, since it has no organizer and the sweep only retires demos, so this also stops strangers changing its bids. The video's "showcase event" therefore has to be a demo gala, which already has every control it needs. The other fix the review offered is to let guests in and have the sweep void their holds some days after bidding ends.
53. **A settled gala can still be reset.** "Already reset" is `demo_expires_at` in the past, not status `settled`, as the review suggested, because starting over after a finished charge has to work.
54. **Chat replies are checked for a shorter list than the autopilot's why.** Both refuse "guaranteed", "you'll win", FMV, IRS, tax and deduction wording, write-offs and market value (`src/server/glim/bannedWords.ts`). Only the why also refuses "promise", "definitely" and "certainly", which a normal chat reply can say. A hit replaces the whole reply with the amount guard's template line, and the stream stops before any of it shows.
55. **The Glim check reads the largest authorization the paddle had when the bid was placed**, with a 1-minute margin for PayPal's clock, rather than `glim_actions.hold_cents_at_time`, because the check is meant not to trust Glim's own log.
56. **20 streams per client address.** The review's test only needs fewer than 30. A venue's guests behind one address past 20 fall back to 5-second polling, and keep trying to get a stream back.
57. `error_log` rows go after 30 days. Text Postgres refuses (a NUL) answers 400 on any API route and writes no row. A chat message holding a NUL is refused before the model is called.
58. A `PAYMENT.CAPTURE.PENDING` only tells a row which capture it is on when it does not know yet. That is narrower than the review's wording ("unknown or the same one"), which its own test rules out: the row keeps the declined capture's id through a retry. Ignoring one costs nothing, since a row back on the queue asks PayPal again.

## Review fixes (Nov 8, second wave)

Each finding was confirmed by its failing test first (22 failing tests in 14 files), and all 22 now pass unchanged.

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| High | Reset could be replayed with the retired gala's session, and each call started a live gala | The new gala and the end of the old one are one transaction. A second press is refused, even one that began first and reached the lock later, and the organizer's session is deleted | `reset-replay-starts-new-galas` |
| Low | Reset at capacity destroyed a closed gala that could still be charged | Same transaction: a 503 changes nothing. A live gala's own slot does not count against it | `reset-at-capacity-destroys-gala` |
| Medium | An authorization on a canceled, denied or failed hold could keep the guest's money held for up to 29 days | `markAuthorized` stores it as `replaced` under the status guard, so the sweep retries a failed void, and the webhook voids one it is first to report | `authorization-on-canceled-hold-never-voided` |
| Medium | A PENDING authorization never settled | When the replay still says PENDING and the webhook says CREATED, the webhook's authorization is stored. Authorizing again still comes first, because it brings the payer | `pending-authorization-never-settles` |
| Medium | A voided hold on a guest who won nothing blocked every charge for good | The check reads the hold in place when the bid was placed, and only a winner's problem blocks | `glim-check-blocks-on-voided-nonwinner` |
| Medium | A real hold on the seeded event could never be released | See decision 52 | `seeded-event-real-hold-stranded` |
| Medium | One guest's messages could refuse every other guest's Glim | One turn running and one waiting per paddle; the next is refused at once | `turn-lock-one-guest-starves-glim` |
| Medium | The chat reply had no code check for banned words | `guardReply` and the stream guard check them, and the pattern moved out of `autopilot/copy.ts` | `chat-reply-banned-words` |
| Low | Retry could reopen a retired demo and charge it | Retry needs the event `settling`, read under locks. Retiring locks the event row before it reads the settlement, so the two cannot pass each other | `retry-revives-retired-settlement` |
| Low | Capture events could move a row backward | See decision 58. A DECLINED must name the capture the row waits on | `webhook-moves-capture-backward` |
| Low | Bad stream input and a NUL slug answered 500 and filled `error_log` | Positions past bigint's maximum are ignored, a NUL slug is an unknown event on every read, and the sweep prunes `error_log` | `bad-stream-input-fills-error-log` |
| Low | One client could take all 1,000 streams | See decision 56 | `stream-no-per-client-cap` |
| Low | `/paypal/cancel` worked with only a hold id | Changing a hold takes the order id PayPal appends. Without it, the page says nothing changed | `cancel-window-without-token` |
| Low | The verify request id ignored the body | It now hashes the whole verification request, so a redelivery keeps its id and anything else gets a new one | `webhook-verify-request-id-ignores-body` |

**Regression tests added:** every press order of Reset, a Reset after a finished charge, sessions after a Reset, the Retry and retire race, holds that ended denied or failed, a webhook void that fails and is retried, capture events on a row with no capture yet, the check's timing and non-winner rules, stream slots coming back, a paddle's third message, NUL text, the 30-day prune.

**Mutation check:** 8 mutants of the less obvious lines, all caught. They were the wall clock in Reset's read (caught only after I added a test that forces the order), the fence's lock, the stream guard's banned-word check, DECLINED's capture id, the check's `blocking` and its timing, Retry's event check, and giving a stream's slot back.

**Three pinned tests changed**, because each asserted the old behavior:
- The session surviving a Reset (`tests/integration/director/controls.test.ts`).
- The sweep report's exact shape (`tests/integration/director/sweep.test.ts`).
- The verify request id (`tests/unit/paypal/webhooks.test.ts`).

## Test counts

`npm test`: 142 files, 1,370 tests, about 20 s, all passing. Day 1 ended at 47 files and 373 tests.

| Suite | Files | Tests |
| --- | --- | --- |
| Glim (unit) | 18 | 218 |
| PayPal (unit) | 8 | 105 |
| Holds (unit) | 5 | 87 |
| Demo (unit) | 5 | 65 |
| Read models (`src/server/queries`) | 6 | 53 |
| UI (unit and `src/ui`) | 6 | 53 |
| Chat (unit) | 4 | 40 |
| Engine (unit) | 4 | 38 |
| API helpers (unit) | 3 | 34 |
| Director (unit) | 2 | 24 |
| Organizer (unit) | 1 | 22 |
| Review findings (unit) | 6 | 24 |
| Settlement (unit) | 2 | 19 |
| Env, schema contract, sessions, stream types (unit) | 5 | 36 |
| Settlement on Postgres | 6 | 118 |
| Director on Postgres | 5 | 91 |
| API routes on Postgres | 4 | 60 |
| Chat on Postgres | 3 | 56 |
| Holds on Postgres | 2 | 46 |
| Stream on Postgres | 3 | 41 |
| Plans and autopilot on Postgres | 7 | 38 |
| Engine on Postgres | 6 | 17 |
| Seams on Postgres | 3 | 15 |
| Demo on Postgres | 2 | 13 |
| Read models on Postgres | 3 | 13 |
| Review findings on Postgres | 20 | 28 |
| Sessions on Postgres | 1 | 10 |
| Database (`db/` and the test database) | 2 | 6 |

**Browser checks on this tree:**

| Server | Specs | Result |
| --- | --- | --- |
| `next dev`, frozen clock | fidelity, guest-pages, entry, healthz, glim-fidelity, control-room-fidelity, power-fidelity | 18 of 18 |
| `next dev`, no frozen clock, no tick | live, hold, glim-panel, control-room, together | 51 of 51 in 1.1 minutes |
| `next dev`, real tick | golden-path | 1 of 1 in 1.5 minutes |

After the review fixes I reran hold, glim-panel, control-room and live with no frozen clock and no tick (51 of 51 in 54 s), and golden-path on the real tick (1 of 1 in 1.5 minutes). The `together` and frozen-clock specs were not rerun, because nothing they render changed.

**On the built app, keyless, in production mode (curl):**
- **Reset:** 201, then 401 on the same cookie.
- **Bad input:** a position past bigint's maximum got 200; a NUL slug got 404 on the poll and on join, and no Postgres error on the pages.
- **Seeded event:** join got 403 `event_view_only`.
- **Cancel:** without its token 409 and nothing changed; with it 200, canceled.
- **Streams:** the 21st from one address got 429, and a new one opened once the others closed.

## Known gaps

- **Not run anywhere yet:**
  - The hosted URL, including the stream through Render's proxy and the first cron sweep.
  - A real sandbox window through the app (it needs a human approval), and capture and void confirmed by webhook.
  - Safari.
  - The autopilot beat through the app on live Claude.
- **Not built, by plan (Day 4 and 5):**
  - 10 My paddle, 11 receipt and 14 projector are Day 1 stubs. The nav's "My paddle" link opens the stub. The receipts they read are already written.
  - The role menu, demo controls, demo guide and Sandbox marker (design/18).
  - Insights (design/28). The other lot drawings (design/29). The 08 footer line "Riverside Shelter Gala · runs on Fairhold".
- **The autopilot's last steps:**
  - After V1 is approved: set `PLAN_CARDS_ARM_AUTOPILOT` and draw the block in `src/ui/glim/cards.tsx`, in the same change.
  - V3 needs a session-bound raise route that calls `createHold` with the stored amount, and a `create` option on `useHoldWindow`, which posts a client amount today.
- **Plan items:** `glim_plan_items.status` stays `watching` after Start bidding. The snapshot's lot list says "you're winning", so Glim reads correctly, but the item label lags.
- **Keyless limits:**
  - After a server restart the simulation forgets `paypal`-kind holds, so the check fails with `INVALID_RESOURCE_ID`. Start a new demo.
  - Recorded Glim knows five chat sentences; anything else gets "I can only replay recorded answers right now. You can still bid yourself."
- **What the review fixes assume about PayPal, not yet seen on the sandbox:**
  - The cancel URL carries `token`. If it did not, a guest's cancel would change nothing, and the window would stay `pending_approval`, which is harmless (decision 3).
  - `PAYMENT.AUTHORIZATION.CREATED` carries `custom_id` and a status, and says CREATED when a review ends.
  - A PENDING authorization can be voided. If it cannot, the sweep keeps trying until the authorization expires.
- **Left open after the review:**
  - `/paypal/return` still accepts a hold id alone. At real PayPal that gets `ORDER_NOT_APPROVED`. In keyless mode, where approval is instant, an organizer could approve a guest's window, and no money is involved.
  - One person with many paddles can still fill the 16 turn connections, one paddle per slot, limited by 60 joins per hour.
  - The per-client stream limit relies on `cf-connecting-ip`, which Cloudflare sets; without Cloudflare in front, a client can forge `x-forwarded-for`. The poll route has no limit of its own.
  - A DECLINED that arrives before its PENDING, for a capture the row never learned of, leaves the row `pending` until "Ask PayPal again".
- **Older notes:**
  - An unknown slug shows the not-found page but answers HTTP 200.
  - The reauthorize round from Day 1's review is fixed (`src/server/settlement/reauthorize.ts`).
- **E2E:**
  - Specs are not in CI.
  - Delete `.next` when you restart `next dev`, or after `next build`. Starting dev over an existing `.next/dev` caused a reload loop in the tracks' runs (247 navigations in 12 s).
  - Each full run starts about 50 demos. The 25-active cap and 5-per-client limit apply on `next start`, not under `next dev`.
  - `live.spec.ts` and `glim-panel.spec.ts` need the server's `DATABASE_URL`.
- **Load:** one earlier full run saw "too many clients already" with several tracks sharing one Postgres. It did not recur with one run at a time.

## Undrawn states

Each renders with existing approved components and plain copy, with no new layout, until its image is approved.

| Where | What renders now | Replaced by |
| --- | --- | --- |
| Home | Plain form and two lines | design/16 |
| Join | Plain form | design/16b |
| Join on a seeded event, in production | Plain form, then the refusal line under it | design/16b |
| Demo ended, deleted or retired event | "This event has ended" on 12; Next's default 404 elsewhere | design/16c |
| PayPal blank window | Plain "Opening PayPal…" | design/17 frame 1 |
| Return and cancel pages | Unstyled | design/17 frames 2–4 |
| Cancel page with no order token | Unstyled "This PayPal window belongs to another hold" | no image; nearest design/17 frame 4 |
| 09 approved, before leaving | Button text and "Taking you back to bid…" | design/17 frame 3 |
| Popup blocked | Immediate redirect | design/17 frame 5 |
| Role menu and demo controls | Nothing; routes only | design/18 |
| Invite link | Route returns `{ href, url }`; nothing shows it | design/18 |
| Reset, landing in the new gala | Route returns `href` and the cookies; no UI | design/18 |
| Reset refused (capacity, charging, already reset) | Route returns the error; no UI | design/18 |
| 12's role menu and close control | None | design/18 |
| 12 for a non-organizer | Guest goes to lots; no session goes to join | no image; nearest design/18 |
| 05 "Max…" opened | Max… in ink, plain field, button "Set max $X" | design/19 state 2 |
| 05 after setting a max | Plain line "Your max on this lot is $X." | design/19 state 2 |
| 05 over bidding power | Place bid stays; plain line and "Raise bidding power" link | design/19 state 3 |
| 05 outbid | Approved pill, button still "Place bid" | design/19 state 4 |
| 05 no bids | "Starting bid", usual presets | design/19 state 5 |
| 05 no hold | Place bid stays; plain line and "Set bidding power" link | design/19 state 6 |
| 05 before open | Plain line from the server | design/19 state 7 |
| 05 closed | Reduced card, "Final bid", pill "Won at" or "Closed at", no presets | design/19 states 8, 9 |
| 05 agent link | Still "Let the agent bid on this lot" | design/19 |
| 05 below minimum | Plain line from the server | no image |
| 05 share with no share sheet | "LINK COPIED" in the PHOTO label's place for 2 s | no image |
| 05 while a bid is sending | Button disabled, no visual change | no image |
| 08 not set | Nav "Not set", no band | design/20 state 1 |
| 08 closed tiles | "Closed at" or "Won at" pill, tile stays in place | design/20 states 4, 5 |
| 09 "Other…" field, hint, errors, disabled button | Plain field and one line | design/20 frames 7, 8 |
| 09 waiting | Button "Finish in the PayPal window", plain "Continue in this tab" link | design/20 frame 9 |
| 09 canceled | One line above the button | design/20 frame 10, design/17 frame 4 |
| 09 failed or declined | One line above the button | design/20 frame 11 |
| 09 raise mode | Approved layout, plain copy | design/20 frame 12 |
| 09 still confirming, window lost, approval refused | One line each | no image; nearest design/20 frame 9 |
| 09 bidding closed, already at the maximum | Plain heading and link | no image |
| Nav after charging | "Not set" | no image |
| Plan card's "ON MY OWN" block (V1) | Not drawn; switch off | design/21 |
| Autopilot cards (V2, V3), "Deciding…" | Stored; `UndrawnAutopilotCard` returns null; no Skip or raise buttons | design/21, design/21b |
| 07 first open, no plan | Approved "On duty · $500 held with PayPal"; chips Raise my budget, How am I doing? | design/22 #1 |
| 07 no bidding power | "Hi Jamie. Set your bidding power first…", grey dot, chip | design/22 #2 |
| 07 thinking | Glim bubble with "…", chips hidden, send dimmed | design/22 #3 |
| 07 error fallback | Bubble "You can still bid yourself." | design/22 #4 |
| 07 refusal and raise offer | Reply bubble, 07's lime button, 10's note under it | design/22 #5, #6 |
| 07 plan edit | Edit prefills "Change my plan: "; the maximums route has no UI | design/22 #7–#9 |
| 07 started or replaced card | Muted "Started at…" or "Replaced at…", plain Pause, Resume and Edit | design/22 #10, #11, #22 |
| 07 paused | "Paused · $500 held with PayPal", grey dot, chip "Resume Glim" | design/22 #10, #11 |
| 07 off duty | "Off duty since 9:30 PM", one chip; the input stays open | design/22 #12 |
| 07 other event cards | 07's card layout; won and lost use 10's grey "Closed" chip | design/22 #13–#21 |
| 07 cap, nothing-fits, empty and long-message lines | Plain bubble | design/22 #22 |
| 12 bidding open | "Closes at 9:30 PM", would-charge figures, disabled "Charge winners", Winning / Not winning chips | design/24 §1 |
| 12 PayPal being asked | "Checking…", charge off | design/24 |
| 12 charging | "Charging N of M", charged so far, disabled "Charging…" | design/24 §2 |
| 12 status column | Replaces Glim and Held once charging starts | design/24 §2 |
| 12 charged | "N winners charged", transaction id lines, no receipt link | design/24 §3 |
| 12 failed or waiting row | "N charged, M not settled", row Retry, rail Retry or "Ask PayPal again" | design/24 §4 |
| 12 failed check | "Can't charge yet", ✕ marks, paddle lines, "Check again" | design/24 §5 |
| 12 simulated guests | "$X held · N bidders", "The 85 simulated guests settle without PayPal." | design/24 §6 |
| 12 other plain lines | "Glim placed no bids", "N lots had no bids", orb with no bubble | design/24 |
| 12 nav | "Lots" and "Bidders" as plain text, as drawn | design/27 |

## Run it locally

`.env.local` holds your real keys, and values already set in the shell win over it. Set these for a keyless run:

```sh
export PAYMENTS_MODE=simulated GLIM_MODE=recorded
export PAYPAL_CLIENT_ID=""
export PAYPAL_CLIENT_SECRET=""
export ANTHROPIC_API_KEY=""

npm run db:start && npm run db:migrate && npm run db:seed   # the seed prints the instant to freeze at
npm run typecheck && npm run lint && npm test
npm run build

# The approved look, and the frozen specs. Delete .next before each `next dev`.
rm -rf .next
FREEZE_CLOCK_AT=<the seed's> npx next dev -p 3456
PLAYWRIGHT_BASE_URL=http://localhost:3456 FREEZE_CLOCK_AT=<the seed's> DATABASE_URL=<the server's> \
  npx playwright test tests/e2e/fidelity.spec.ts tests/e2e/guest-pages.spec.ts tests/e2e/entry.spec.ts tests/e2e/healthz.spec.ts tests/e2e/glim-fidelity.spec.ts

# Live behavior: no frozen clock, no tick
rm -rf .next
npx next dev -p 3456
PLAYWRIGHT_BASE_URL=http://localhost:3456 DATABASE_URL=<the server's> \
  npx playwright test tests/e2e/live.spec.ts tests/e2e/hold.spec.ts tests/e2e/glim-panel.spec.ts tests/e2e/control-room.spec.ts

# The whole path on the real tick
rm -rf .next
ENGINE_ENABLED=true npx next dev -p 3456
ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/e2e/golden-path.spec.ts
```

The control room is at `/e/<slug>/organizer`, and only the demo's creator can open it. To capture 09 and 12, see the headers of `tests/e2e/power-fidelity.spec.ts` and `tests/e2e/control-room-fidelity.spec.ts`.
