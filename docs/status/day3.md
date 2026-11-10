# Day 3 status: Mon Nov 9, 2026

Every approved board is built: design/16 to 29, with 21's V1 to V7. The autopilot is on as shipped. In a browser on the real tick, the rival's $400 makes Glim move the $380 left to Wine Tasting with a $220 bid, and nobody taps anything. The path then runs on through the demo menu's Close bidding now, 12 charging, 11's receipt, 14's projector and Insights.

On live Claude, through the app, the model made that same move in 3.5 s. Its card showed 5.2 s after the rival's bid. Six tracks built in parallel in one tree, and this file records how they were fitted together.

Typecheck, lint and the production build pass. All 1,574 tests pass. Every Playwright spec passes on its own server. The second review's four findings are fixed (see Review fixes), and the lead's own checks made two more changes (see The lead's checks).

## What works

| Board | What runs | Where |
| --- | --- | --- |
| 16, 16b, 16c | Home with one "Start a demo gala" button (the creator is Jamie, paddle 142), join by invite, and "This demo gala has ended" over a reset, expired, deleted or mistyped gala. Both forms are Server Actions, so a press before hydration still works | `src/app/page.tsx`, `src/app/e/[slug]/join/`, `src/ui/entry/`, `src/ui/demo/DemoEnded.tsx` |
| 17 | The PayPal window's five frames: `/paypal/start`, the slow-answer frame (after 400 ms), approved (closes after 3 s), canceled, and "Continue to PayPal in this tab" when the popup is blocked | `src/app/paypal/`, `src/server/paypal/window-page.ts`, `src/ui/power/` |
| 18 | The creator's role menu: Guest view, Organizer view, Close next lot, Close bidding now, Add 10 minutes, Invite a guest, Reset demo. Also the five-step demo guide on 08, and the Sandbox demo marker on demo galas only | `src/ui/demo/` |
| 19 | 05's nine bid card states, "Let Glim bid on this lot", the max field, over bidding power with a raise to the covering total, and a spinner after 300 ms | `src/ui/lot/bid-card-state.ts`, `src/ui/lot/BidCard.tsx` |
| 20 | 08's not-set band and closed tiles (sold, won, no bids), and 09's frames 7 to 12 | `src/ui/catalog/`, `src/ui/power/` |
| 21, 21b | The "On my own" block (V1), "Deciding…", Glim's own card with Skip (V2), and the prepared raise (V3) through a route that opens PayPal only for the stored amount. V4 is 10's feed, V5 the demo guide, and V6 12's check row | `src/server/plans/`, `src/server/chat/`, `src/ui/glim/`, `src/app/api/glim/[slug]/raises/` |
| 22 | All 23 panel states: the plan editor with fields and "This plan needs $X", "My new plan for you" with WAS, "Update and resume" (B4), and pause bars and Resume in the header | `src/ui/glim/`, `src/server/chat/view.ts` |
| 23 (10) | My paddle on Postgres and the live stream: rows, the rule lines, Glim's activity feed, Pause, Resume, Edit plan, and the B3 states | `src/ui/paddle/`, `src/server/queries/paddle*.ts` |
| 24 (12) | Live with a countdown, charging, charged, a failed row, a failed check, waiting rows, the honest simulated lines (C1, C2), Close bidding now on the rail (C3) and the V6 row (C4). Two causes of a stuck "Checking…" are fixed | `src/ui/organizer/`, `src/server/settlement/ledger.ts` |
| 25, 25b (11) | The receipt in its three states, the stamp "Sandbox demo · not a tax document", placeholder charity lines (C5), and a US Letter print page with "Download PDF" | `src/ui/receipt/`, `src/app/e/[slug]/receipt/` |
| 26 (14) | The projector before open, live, in the last lots and after the close, with the C6 marker and line in demos. It is public and scales to any screen | `src/ui/projector/`, `src/server/queries/projector*.ts` |
| 27 | Every nav link goes to a real page. "How it works" is gone. After the close, My paddle opens 11. The organizer nav is Control room, Insights and Projector | `src/ui/EventNav.tsx`, `src/ui/organizer/OrganizerNav.tsx` |
| 28 | Insights: the widgets, the line chart (plain SVG; AG Charts is not installed), and AG Grid Community's top lots with sort, filter, flash and CSV | `src/ui/organizer/InsightsScreen.tsx`, `src/server/settlement/insights.ts` |
| 29 | All 24 lot drawings. Lot 01 has its own puppy | `src/ui/drawings/` |

### The path as shipped (autopilot on)

`tests/e2e/golden-path.spec.ts` covers this path in real browsers, on the real tick and the real clock, on simulated payments and recorded Glim. It passed three times today: 1.5, 1.8 and 1.9 minutes, the last on live Claude.

1. Home, then "Start a demo gala". The nav reads "Not set" with the Sandbox demo marker.
2. Kai joins by invite. 14 is open, live, in Kai's browser: "Your bids are backed by bidding power held with PayPal."
3. The nav's pill opens 09, and the hold goes through the window. The nav reads $500 / $500.
4. Jamie bids $320 on Chef's Table, and Kai's browser follows without a reload. Lot 03 shows design/19 state 3.
5. Jamie hearts Wine Tasting, which makes it the plan's backup.
6. The golden sentence. The plan card has the On my own block ("Never past $500 in all, and Spa Day up to $120.") and the Wine Tasting row. Before Start bidding, the header reads "Not bidding yet". After it, Glim bids $90 on Spa Day.
7. The rivals: Glim answers the $360 at $380, then the $400 passes the limit.
8. Glim's card: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380.", with "Skip Wine Tasting". The nav reads $190 / $500.
9. 10 shows Wine Tasting winning. Glim's feed has the WINE TASTING row with "Winning · $220".
10. The demo menu's Close bidding now. 10 moves to 11, closed and not yet charged: "Receipt pending", $310 to pay.
11. Organizer view: Ready to charge, All passed, then Charge 20 winners. Paddle 142 reads Charged, $310, $190.
12. "See your receipt" opens 11, paid, with Wine Tasting and Spa Day won by Glim.
13. 10 after the close leads to 11. 14 after the close shows "I bid for 1 guest". Insights opens from the organizer's nav.

`tests/integration/seams/golden-path.test.ts` runs the same path through the route handlers. It now also asserts two things: 10's feed chip is $220 (the bid, not the $380 maximum), and after the close the plan card's backup reads "Won at $220". Its last case still turns the switch off, as `GLIM_AUTOPILOT=off` would. With the switch off, nothing moves and the charge is $90.

### The autopilot on live Claude, through the app

Run on `next dev`, the real tick, simulated payments and `GLIM_MODE=live`, by the same golden-path spec. It passed in 1.9 minutes.

- **The golden sentence:** claude-opus-5-5 answered in 2.65 s with 185 output tokens. The plan was $380 and $120, as recorded.
- **The rival's $400:** it landed at 12:43:55.9 PM. The autopilot run took 3.5 s, of which 3,473 ms was the model call (662 input and 249 output tokens). The card was stored at 12:44:01.1, 5.2 s after the bid. The exit test asks for 15 s.
- **The decision:** `change`, reason `top_lot_out_of_reach`. Spa Day became priority 1 and Wine Tasting priority 2, with no maximums of the model's own. It was applied unadjusted, with no validator issues. The engine's lines are the same as recorded: "I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380."
- **The model's why:** "The chef's dinner is now beyond your budget, so I'm keeping the spa day and putting the freed money toward the wine tasting backup."
- **The charge:** $310 captured and $190 released, as in the recorded run.

"Deciding…" showed in the header for the 3.5 s of the run. The browser did not capture that moment.

### Fidelity

| Screen | Against | Pixels over 48/255 | Where |
| --- | --- | --- | --- |
| 08, 05 | `docs/status/ui-08-lots.png`, `ui-05-lot-detail.png` | 1,075 and 4,149 (fidelity.spec passes); 0 against captures of HEAD | Those PNGs are Day 1's: the nav's design/27 links (both), and 05's "Let Glim bid on this lot" (was "Let the agent bid"). Measured Nov 9; earlier rows said 0 |
| 09 | Day 2's `docs/status/ui-09-power.png` | 1,073 | All in the nav (design/27's links) |
| 09 | `mockups/09-web-bidding-power.png` | 1,401 of 5,184,000 | The nav, plus Day 2's 326 corner pixels |
| 12 | `mockups/12-web-control-room.png` | 3,290 of 5,184,000 | 2,964 in the nav, 326 in the corners |
| 28 | `design/28-insights.png` | 57,787 of 6,261,120 (0.92%) | The nav and text edges |
| 07 | design/21, 21b and 22, part by part | glim-fidelity.spec passes | Under 0.5% per part, about 1.5% on Glim's card (the "→" glyph falls back from Geist Mono) |
| 10, 11, 14, 25b | Their boards | 0.86% to 3.1% (paddle track) | Text edges and real data; layout within 1px |
| 29 | Each drawing cut from the board | 0 to 4 pixels each; Lot 08 at 18 | Sub-pixel position |

## Decisions taken by the lead

| | Decision | As built |
| --- | --- | --- |
| B1 | The cabin raise is offered only when the raised maximum covers the next bid with the plan running | `src/server/plans/raise-offer.ts`. A suggestion too small for the lot rises to the smallest preset that covers it. The cabin fixture has a second reply for 22 state 6 |
| B2 | Panel 07 loses the "+", shows pause bars while a plan runs, and reads "Not bidding yet" until Start bidding | Applied to every frame |
| B3 | Screen 10 without new drawings | No hold goes to 09. After the close, 11's closed, not yet charged state. Bids but no plan shows state 1's Glim card beside the rows. A raise in a window shows 20's "Finish in the PayPal window" |
| B4 | Editing while paused | "Update and resume", which resumes |
| C1 | Board 24 in demos | The honest lines are counted from the event ("The 85 simulated guests settle without PayPal."). The third check reads "Every PayPal hold is still valid" |
| C2 | Row status | Simulated for database rows; Charged and Released for real holds |
| C3 | Close bidding now | On 12's rail and in 18's menu. "See your receipt" is the lime button once charged |
| C4 | 24 with V6's row | Both rows are kept, and the ledger grows to the rail's height |
| C5 | Receipts | No tax-records line and no "You received the items" line. The charity name and EIN are labeled placeholders |
| C6 | Projector in demos | The Sandbox demo pill beside the status pill, and "Your bids are backed by bidding power held with PayPal." |
| C7 | Lot drawings | The five from 13b are kept (02, 04, 06, 22, 23) |
| Switch | V1 approved | `PLAN_CARDS_ARM_AUTOPILOT = true`, in the same change that draws the block. `GLIM_AUTOPILOT=off` still wins |
| Day 2 #52 | Stays | The seeded event is view-only in production: join on the built app answered 403 |

Day 2 decisions now settled by the boards: #1 (Close bidding now exists), #6 (a blocked popup gets frame 5's button), #22 (the mandate is stored, since the switch is on), and #27 (the "+" is gone).

## Decisions the tracks made

**Entry**
1. Home has no name field, so organizer view reads "J Jamie · Organizer", not the boards' "Dana". `/api/demo` still requires `firstName`.
2. The forms are Server Actions. A hydrated form loads the answer in full, because a soft navigation left a not-found page's DOM behind.
3. 16c covers any slug with no live event, so a mistyped slug also reads "This demo gala has ended". `[slug]/not-found.tsx` handles missing pages of live events.
4. The demo guide shows on 08 only. Its insets go from 14.5 to 8px to clear 08's prices. The current step never moves backward.
5. The Sandbox marker shows only when the layout flags a demo, so the seeded event keeps its approved look.
6. Frame 2 shows only after 400 ms. Approved closes after 3 s; canceled stays open. The window pages load Geist from `/paypal/fonts/[file]`.
7. Demo control results and refusals appear in a card styled like the menu. There is no confirm step for Reset.

**Lots**
1. The agent link shows on open lots only (states 1 to 6).
2. The won line follows the event: "at 9:30 PM" while bidding runs, "shortly" once closed, "Paid with PayPal" once settled.
3. "Sold to Paddle N" comes from a new leaders query on 08 (`listLeaderNumbers`).
4. Raise mode offers $1,000 and Other…, because the story's presets are $250, $500 and $1,000.

**Glim**
1. The closing card reads in the past tense after the charge.
2. "Both lots in your plan" counts only lots Jamie planned. In the autopilot demo it reads "You won 2 lots. You'll pay $310…", not 21b's $470.
3. In the editor, maximums that add up exactly to the budget leave the first lot uncapped, as 22 #9 draws.
4. Skip offers only planned lots. "Resume Glim" left the chips because Resume is in the header.
5. "Not now" is stored as `detail.dismissedAt`. Another open tab sees it on its next read, within 30 s.
6. Every model failure reads "I can't answer right now. You can still bid yourself."
7. Plan edits are stored as kind `plan_edited`.

**Paddle**
1. 10's feed is executed `glim_actions` only.
2. The two-line rule shows when the running plan has a mandate.
3. Close times round to the nearest minute on 10, 11, 25b and 14. 08's tiles truncate instead.
4. 11's header date is the gala's close. "Email me a copy" opens a draft in the guest's own mail app, since Fairhold sends no mail.
5. 14 counts bidders as paddles that held or bid (86 on the seed). Its QR carries the gala's full link at level L.

**Organizer**
1. Insights uses the board's past tense only once charged. Before that it reads "will be charged" or "is bid now".
2. 12's "Download CSV" is also on Insights.
3. The V6 count is read-only and computed in the ledger; `checks.ts` is unchanged.
4. A checks request keeps only its latest answer, gives up after 45 s, and a failure reads "Not checked yet" with "Check again".

**Drawings**
1. The 16 new drawing keys are named by the track.
2. The board-matching test skips itself when `design/` is missing, as it is in CI.

## What integrating changed

- **Lint:** `eslint.config.mjs` ignores `.next-*/**`. Every track's lint failed on the other tracks' dev folders.
- **Leftovers:** `tsconfig.json` is back to HEAD, without the `.next-<track>` include lines `next dev` had added. The leftover `fairhold_drawings` database is dropped. No track's `.next-<track>` folder was left.
- **10's feed** (`src/server/queries/paddle.ts`), the two notes the glim track left for the paddle track:
  - An autopilot row's chip reads `detail.chipCents`, the $220 bid rather than the $380 maximum.
  - `plan_edited` reads "PLAN UPDATED".
- **09's "Didn't open? Continue in this tab"** now marks the tab as PayPal's, so the return page goes straight back to the auction. This was the entry track's open item.
- **One receipt link:** `EventNav` uses `receipt/receipt-href.ts` instead of its own copy.
- **States the sweep found:**
  - After the close, 08's band read "Let Glim bid for me". It now offers "See your receipt".
  - 09 no longer shows "Not sure how much?" once bidding has closed.
  - 11 for a guest who never held bidding power no longer says "Your whole hold was released". It reads "You didn't set bidding power, so nothing was held."
  - The plan card's backup row read "Current bid $220" after Jamie won it. It now reads "Won at $220".
- **Insights' time axis:**
  - On a demo closed early, "12:30" ran into "12:40 PM", so a round time now needs 80 units of clearance from an end.
  - A window of days, such as the seeded evening read on the real clock, stacked 20 labels. The steps now go up to 24 hours.
- **Specs:**
  - The golden-path spec is rewritten for the autopilot path. `GOLDEN_PATH_SHOTS=<folder>` saves a screenshot of each step.
  - guest-pages expects the event's own not-found page.
  - live.spec and lot-states.spec made their pool once per file, but with `fullyParallel` the file's `afterAll` runs after every test. They now make it again when needed.
  - hold.spec waits for the approved window to close before the next raise.
- **READMEs:** `src/ui`, `src/server/settlement` (Insights, V6 row), `src/server/holds` (the raise route) and `src/server/demo` (drawings, the numbers where the story wins).

## States still plain or undrawn

Each renders with approved components and plain copy.

| Where | What renders | Nearest board |
| --- | --- | --- |
| Demo control results, invite card | A card styled like the menu, with the route's sentence | 18 |
| 12's organizer pill | The same role menu | 18 |
| PayPal window: pending, declined, refused, error | Frames 2 and 4 layouts with the existing lines | 17 |
| Join after the close | "Bidding has closed", no form | 16b |
| Event and site not-found pages | 16c's column, "We could not find this page" | 16c |
| 05 closed with no bids | "This lot closed with no bids" | 19 |
| 09 still confirming, window lost, refused | Frame 9 or 11 style | 20 |
| 09 "Bidding has closed", "at the top" | Plain heading and link | 20 |
| 08 before bidding opens | Tiles with their open time | 20 |
| 08's band after the close | "See your receipt" in the Glim button's place (integration) | 20 |
| 07 raise card while its PayPal window is open | 09's labels | 21 |
| 07 "Paused since 10:31 AM" | Truncated with an ellipsis beside Resume for two-digit hours; the drawn "9:15 PM" fits | 22 |
| 07 editor's "That's your bid there." | Plain line | 22 |
| 10 raise waiting | 20's frame 9 in Raise's place | 23 |
| 11 before release for a guest who won nothing; 11 for a guest who never held | Future tense ("Hold releasing"); "You didn't set bidding power…" | 25 |
| "Simulated" in 11's and 12's ID rows | The word, no ID | 24, 25 |
| 25b's on-screen toolbar | "Back to your receipt", "Download PDF" | 25b |
| 14 Sandbox pill placement; 14 live with no lot open | Beside the status pill; the right column empty | 26 |
| 12 "ended" (retired before charging); a real released row; waiting rows | Plain copy; check and ink; Waiting pill and "Ask again" | 24 |
| Insights while live or ready | "is bid now", "will be charged" | 28 |
| Practice hold (20 state 2, frame 11's offer) | Not built; SHOULD 10 is cut | 20 |

## Review fixes (Nov 9, second review)

The review left one failing test file per defect (4 failing tests in 3 files). Each failed on its own assertion before the fix, and all 4 pass unchanged after it. No review test was edited.

| Severity | Finding | Fix | Test |
| --- | --- | --- | --- |
| High | A PayPal approval refused as bidding power (after the close, or a second window for one raise) and voided was read as the guest's hold. Before the charge, 11 read $800 held and $390 to release, and Glim's card said "You paid $410… the other $390 was released." A guest who won nothing read "Hold released" while the $500 was still held. After the charge, 11 showed the refused approval's authorization ID | New `src/server/holds/bidding-hold.ts`. The hold is the settlement item's hold once the charge has one, else the authorized hold, else the newest hold that ended straight from authorized. A row that ever went to `replaced` (a refusal, a late approval of a canceled window, or a hold a raise displaced) never counts. Refused rows can carry no `replaced_by_hold_id`, so the rule reads their `replaced` row on the paddle's channel, which hold-store writes in the same transaction. 11 (`receipt-view.ts`) and Glim's closing facts (`chat/view.ts`) read it. "Charged" is the settlement item finished, or that hold ended | `tests/integration/holds/refused-approval-not-a-hold.test.ts` |
| Medium | Glim's prepared raise stayed open after the guest edited the plan: the card still offered Approve, the autopilot held it as pending, and the route opened a $540 window | The offer must belong to the active plan (`a.plan_id`), in `loadOpenRaiseOffer` and in `pendingRaise` (`plans/context.ts`). The prepare step's "one raise pending" check now counts only offers for the running plan, so an ended offer does not block the next one | `tests/integration/plans/raise-offer-ends-on-plan-edit.test.ts` |
| Low | V6's read-back never checked "Never past $500 in all" | `decisionOutsideRules` flags a decision whose planned maximums add up past the named budget, unless it only lowers or drops (R9). That exception is computed from the action's `before` and `after`, as `buildChange` decides it, since the stored detail has no flag. The review's second gap is fixed too: a lot the guest skipped counts against a decision when the Skip (skipLot's `plan_edited` action with the lot) came first | `tests/unit/settlement/v6-readback-budget.test.ts` |
| Low (fidelity) | 16's panel lost its height without the sandbox buyer card: 412px, with the band on its top edge | `py-52` on the `aside`: 516px, the band 52px from the top as drawn (51.5 on the board). With the buyer card the column is 516px anyway. Against the board's crop the showcase differs by 1,031 of 313,500 pixels, all text edges a half pixel apart | New entry.spec case |

**The reviewer's decisions to check:**
- **The projector and the demo guide counted a refused approval as having held.** Fixed with the same rule: `readProjectorExtras` and `readGuideProgress` use `isOrWasBiddingPowerSql`. The seed still counts 86 bidders.
- **Editor maximums that add up to the budget leave the first lot uncapped**, and **"Not now" has no cooldown.** Both are unchanged and still yours to decide. The new V6 budget check does not change either one.

**What else changed:**
- **An edit ends a prepared raise even when the new plan keeps its lot.** The review asked for the plan check, and it is the simplest rule that never reuses consent given for an older plan. Glim can prepare a new raise for the new plan if it needs one, still within the limit of 2 per guest.
- **Who "never held":** a guest whose only approval was refused now reads like one who never held. 11 says "You didn't set bidding power, so nothing was held." and Glim's card has no released line. PayPal voided that authorization.
- **Edge case in the Skip check:** it compares the decision's `created_at` with the Skip's, and both are transaction start times. A Skip whose transaction began just before a decision's, but took the plan lock after it, would read as earlier. The plan version fence makes that a race of microseconds.

**Regression tests added:**
- `tests/integration/holds/bidding-hold.test.ts`, 4 cases:
  - after the charge, 11 shows the charged hold's authorization ID;
  - a guest whose only approval came after the close never held, on 11, 14 and the guide;
  - an approval authorized after its window was canceled is no hold;
  - after a raise, the raised hold counts, and so does one PayPal voided later.
- `tests/unit/settlement/v6-readback.test.ts`, 7 cases: the golden move passes, an over-budget move, R9, and skips before, after and with no record.
- `ledger.test.ts`: over budget and the Skip's timing, through the ledger's SQL.
- `autopilot-panel.test.ts`: the offer waits through Pause and is open again after Resume, which keep the plan.
- `golden-path.test.ts`: the shipped path's V6 row reads 1 decision, 0 outside the rules.

**Mutation check:** dropping the `replaced`-row test from the rule fails 2 of the 4 new hold cases (the late approval with no hold in place, and the canceled window). The review's own tests catch a return to "newest authorized row".

**Commands:**

| Command | Result |
| --- | --- |
| `npm run typecheck` | passes |
| `npm run lint` | passes, no output |
| `npx vitest run` | 163 files, 1,569 tests, all pass (21.6 s) |
| `rm -rf .next && npm run build` | exit 0, no warnings |

**Browser checks** (Chrome, port 3471, `.next-fix`, database `fairhold_fix`):

| Server | Specs | Result |
| --- | --- | --- |
| No frozen clock, no tick | entry (with the new 16 panel case), healthz | 12 passed, 1 skipped (needs `DEMO_BUYER_1_*`) |
| No frozen clock, no tick | glim-panel, hold, control-room, live, insights | 56 of 56 |
| Frozen at the paddle moment (Nov 7) | paddle-receipt-projector, healthz | 4 of 4 |
| Real tick, fresh database | golden-path, recorded Glim | 1 of 1 in 1.7 min. 12 reads "1 decision · inside the rules" |

The server is stopped, `fairhold_fix` is dropped, `.next-fix` is deleted, and `tsconfig.json` is back to HEAD after `next dev` rewrote it.

## The lead's checks (Nov 9, 1:55 to 2:20 PM)

Run again from the integrated tree, not taken from the reports:

| Check | Result |
| --- | --- |
| `npm run typecheck`, `npm run lint` | both pass |
| `npx vitest run` | 165 files, 1,574 tests, all pass |
| `rm -rf .next && npm run build` | exit 0, no warnings |
| golden-path on `next start` (the production build), real tick, fresh database, recorded Glim | passed twice, 1.5 and 1.6 min. Every step's screenshot read by eye |
| live, hold, glim-panel, control-room, entry, insights, lot-states, healthz on `next dev`, fresh database, 4 workers | 70 passed, 1 skipped (the buyer card needs `DEMO_BUYER_1_*`) |
| paddle-receipt-projector and healthz, frozen at the paddle moment | 4 of 4 |

The many-demo specs need `next dev`: a production build turns new demos away at 25 running, so on `next start` the second batch hit "Too many demo galas are running right now". That is the cap working, not a regression.

Two changes came out of reading the screenshots:

- **A made-up id never sits under PayPal's name.** In a keyless run, simulated payments make ids such as `SIMC1ED2FF3B27A40`, and 11, 25b, 12's rail and the ledger's CSV showed them as the "PayPal transaction ID". They now read "Simulated" (C2's word). A new `src/server/paypal/simulated-ids.ts` knows the exact shape ("SIM", O, A, C or R, then 13 hex digits), so a real PayPal id is never hidden. Tests: `tests/unit/paypal/simulated-ids.test.ts` runs simulated payments' own ids through it, and `ledger-model.test.ts` and `control-room.spec.ts` expect "Simulated".
- **A past close reads the same minute on every page.** The second run closed at 2:03:3x: the nav and 11's date said 2:03 PM, 11's lots "Won at 2:04 PM". 10, 11, 25b and 14 rounded lot closes to the nearest minute (the seed story's rule: Lot 07's 9:16:42 is "9:17 PM"), while the nav, 08's tiles, 05's card, the projector's header and 11's date cut the seconds off. Now `formatClosedTime` in `src/ui/format.ts` rounds every close that has happened. A close still ahead keeps `formatClockTime`, so "Closes 2:21 PM" never names a later minute than the real one. Test: `tests/unit/ui/closed-time.test.ts`.
  - **Left as is:** a demo that runs out on its own (its 25 minutes, say 2:21:40) reads "Closes 2:21 PM" while live and "Closed at 2:22 PM" afterwards. The video's path closes with Close bidding now, which this doesn't touch.

Also tidied: the review's three failing-first tests moved out of `review2/` into their areas (`tests/integration/holds/refused-approval-not-a-hold.test.ts`, `tests/integration/plans/raise-offer-ends-on-plan-edit.test.ts`, `tests/unit/settlement/v6-readback-budget.test.ts`), with headers that describe the rule they now guard.

## Test counts

`npx vitest run`: 165 files, 1,574 tests, about 22 s, all passing. That is after the lead's checks, which added 2 files and 5 tests (PayPal and UI units, not split out below); the review fixes ended at 163 files and 1,569 tests, and the integration at 158 and 1,551. Day 2 ended at 142 files and 1,370 tests.

| Suite | Files | Tests |
| --- | --- | --- |
| Glim (unit) | 18 | 222 |
| PayPal (unit) | 9 | 118 |
| Holds (unit) | 5 | 94 |
| Read models (`src/server/queries`) | 9 | 72 |
| UI (unit, `src/ui`) | 10 | 100 |
| Demo (unit) | 5 | 65 |
| Organizer (unit) | 3 | 59 |
| Chat (unit) | 4 | 47 |
| Engine (unit) | 4 | 38 |
| API helpers (unit) | 3 | 34 |
| Director (unit) | 2 | 24 |
| Review findings (unit) | 7 | 26 |
| Settlement (unit) | 3 | 26 |
| Entry (unit) | 1 | 9 |
| Env, db, sessions, stream (unit) | 5 | 36 |
| Settlement on Postgres | 7 | 131 |
| Director on Postgres | 5 | 91 |
| Chat on Postgres | 4 | 67 |
| API routes on Postgres | 4 | 60 |
| Holds on Postgres | 3 | 50 |
| Stream on Postgres | 3 | 41 |
| Plans and autopilot on Postgres | 7 | 38 |
| Review findings on Postgres | 22 | 31 |
| Read models on Postgres | 5 | 21 |
| Engine on Postgres | 6 | 17 |
| Seams on Postgres | 3 | 15 |
| Demo on Postgres | 2 | 13 |
| Sessions on Postgres | 1 | 10 |
| Entry on Postgres | 1 | 8 |
| Database | 2 | 6 |

**Browser checks** (Chrome, port 3470):

| Server | Specs | Result |
| --- | --- | --- |
| No frozen clock, no tick | live, hold, glim-panel, control-room, lot-states, insights, entry, healthz | 68 passed, 1 skipped (the sandbox buyer card needs `DEMO_BUYER_1_*`), 1 failed: hold's raise, a timing race fixed in the spec. After the fix, hold and live passed 40 of 40 at 6 workers |
| Frozen at the Nov 7 catalog moment | fidelity, guest-pages, healthz, lot-drawings | 35 of 35, after guest-pages took the new not-found copy |
| Frozen at today's catalog moment | glim-fidelity, power-fidelity | 2 of 2 |
| Frozen at the paddle moment | paddle-receipt-projector | 3 of 3 |
| Frozen at the closed moment | control-room-fidelity, insights-fidelity | 2 of 2 (captures) |
| Real tick | golden-path, recorded Glim | 1 of 1 in 1.8 min |
| Real tick | golden-path, live Glim | 1 of 1 in 1.9 min |

**Every page in every state, at 1440×900.** A script visited 130 pages:
- **The states:** a demo with no hold, live with a plan (all 24 lots), Kai without a hold, closed, charged and reset.
- **Others:** the unknown-slug, lot-99, site-404 and bare PayPal window pages, and the seeded event.

What it found:
- **Console errors:** none, except the expected document status on `/nowhere` (404) and the bare `/paypal/return` and `/paypal/cancel` (400).
- **Links:** no dead link on any page.
- **Overflow:** no horizontal scroll. The only flagged text was the screen-reader-only "Closes in" labels, clipped to 1px on purpose.

The four states that looked wrong are fixed above.

**The built app (`next start`, curl):**
- The home page, a new demo, and its 08, 05, 09, 10, 11, 14, 12 and Insights all answer 200.
- So do `/paypal/start` and both window fonts.
- Joining the seeded event answers 403 `event_view_only`.

## On the hosted URL (Nov 9, 8:04 to 9:05 PM)

After #3 and #4 merged, Render deployed main at a3b2c80 (live at 8:03 PM, once CI passed).

- **A sweep without a hold** (headless Chrome, 15 steps, no console errors and no 5xx):
  - Home has one button and no name field.
  - 08 shows the guide, the Sandbox marker and the not-set band.
  - Without a hold, 10 and 11 send the guest to 09.
  - 09's window opens frame 1 ("Opening PayPal…") and lands on PayPal's sandbox with a token.
  - Glim answers on live Claude in 3.5 s.
  - The role menu has its seven items; 12, Insights and 14 load.
  - Kai joins through 16b as paddle 189.
  - A gone gala shows 16c.
- **The whole path with a real sandbox hold** (the built-in browser; the user pressed the hold button, signed in to PayPal and pressed Charge, and the lead did the rest):
  - **Frame 5:** the lead's press was blocked as a popup, and 09 showed "Continue to PayPal in this tab".
  - **The hold:** the user's press opened the window, and $500 was authorized as buyer-1. The approved window closed by itself, and the nav read $500 / $500.
  - **The plan:** after a $320 bid on Chef's Table and a heart on Wine Tasting, live Claude planned the golden $380 / $120 with the "On my own" block.
  - **The autopilot:** at 8:12 PM the rival's $400 passed the limit. Glim moved the $380 left to Wine Tasting and bid $220, with its own why ("The chef's dinner is now beyond your budget…"). No tap.
  - **The close:** Close bidding now at 8:13 PM. 11's date and its lots' "Won at" both read 8:13 PM.
  - **The charge:** 12 read Ready to charge with all checks passed. Charge 21 winners settled at 9:04 PM: $310 captured on PayPal (7AD398548Y635810M) and $190 released. 11 reads paid.
- **Found and fixed:** 10 showed "Finish in the PayPal window" with no raise open. The blocked first try's hold stayed `pending_approval`, and `readRaisePending` counted any pending hold while an authorized one existed. It now counts only one newer than the authorized hold (`src/server/queries/paddle.ts`), with a test that fails on the old query.
- **Not a product fault:** while the built-in browser's pane was hidden, 12 sat on its server-rendered "Checking…" for over a minute. The page had not hydrated. Shown, it asked PayPal and passed in 1.1 s.
- **The seeded event isn't on the hosted database** (`/e/riverside-shelter-gala` shows 16c): deploys run migrations only. Nothing links to it; the Devpost text should link the home page.
- **Narrow windows:** every board is 1440×900 and the phone layout (SHOULD 8) was cut on Nov 7. Below about 1280 px wide the pages overlap and wrap, as the built-in browser's 504 px pane showed. Fixed by the responsive layouts (next section).

## Responsive layouts (Nov 9 to 10)

You brought SHOULD 8 back on Nov 9, as real responsive layouts and without new boards. Five tracks (shell, lots, glim, paddle, organizer) built them in parallel in this tree, and the integrator fitted them together. Two reviewers then went over the result on Nov 10, one at phone sizes and one at tablet and laptop sizes, and a fixer worked through their 26 findings (below). Every page now works from 320 to 1439 wide. At 1440 and up nothing changed: after the fixes, 24 page states captured at 1440×900 (native 2x) on this tree, and the open demo menu, differ by 0 pixels from the integrator's captures of HEAD on the same seeds and frozen clocks; the projector differs only in its join line's port and the QR code that carries it.

### The rule and the breakpoints

- **Only max-width variants.** `max-desk:` (below 1440, laptops), `max-xl:` (below 1280), `max-lg:` (below 1024, tablets), `max-md:` (below 768, phones), `max-sm:` (below 640). No unprefixed class changed. `src/ui/theme.css` adds `--breakpoint-desk: 90rem` and the type sizes 18, 24, 26, 32, 36, 40, 44 and 48 for phones.
- **Widths checked:** 320, 375, 430, 768, 1024, 1280 and 1366 (`tests/e2e/support/responsive.ts`), plus 1440.
- **Arbitrary `max-[Npx]:` variants sort before the theme's,** so they lose to `max-md:` on the same property. Only two are used, each on a property nothing else sets there: `max-[375px]` (the panel header's orb) and `max-[359px]` (12's title and tabs at 320). The review fixes add three stacked ones, each checked in the browser: `max-md:min-[360px]:` (the demo guide bar beside the orb), `max-desk:[@media(max-height:859px)]:` (the guide on a short laptop screen) and `lg:max-desk:[@media(max-height:599px)]:` (Glim's card in a short window).
- **Text that must not split on a line** uses no-break spaces in one text node (`keepTogether` and `wrapAtSeparators` in `src/ui/format.ts`), not a nowrap `<span>`. A span mid-line moved the glyphs after it by a fraction of a pixel at 1440 (26 pixels over 48/255 on 16, 208 to 235 exact on 05); a no-break space draws exactly as a space, measured at 1440 native 2x.
- **What CSS can't reach** (AG Grid's column widths) reads the width with `useMediaQuery` (`src/ui/useMediaQuery.ts`); it answers false on the server, so the desktop columns render first.

### The design, page by page

| Page | Phone (below 768) | Tablet (768 to 1023) | Laptop (1024 to 1439) |
| --- | --- | --- | --- |
| Navs (05, 08, 09, 10, 11, 12, 28) | Two rows, 119px: the paddle mark and gala name over the status pill and Sandbox marker, the paddle pill on the right; then 48px tabs with bidding power on the right. The pills go compact ("Closes 9:30 PM", "$180 / $500", the number alone), with labels kept for screen readers | Same two rows, 32px gutters | One row as drawn, the name truncating first. The gutter follows the pages' 1344 column (43px at 1366, 32 by 1344), so the paddle mark lines up with the content |
| 16, 16b, 16c, not-found | One column. The home title scales to fit each sentence on a line, the button is full width above the fold; 16b's field and button are full width. The fine print wraps only after a "·" | One column | Two columns on home; the panel takes up to 544 |
| 17, the PayPal window | Below 480 wide or 560 tall: one column, the button 48 tall and full width, the trust line at the foot | The popup (520×720) keeps its drawn layout | As drawn |
| 18, the role menu and demo guide | The menu stays 16px inside the screen, items 44 tall; on a short screen (a phone held sideways) it scrolls inside. The guide is a 44px bar, "Demo guide · Step 1 of 5", that opens its steps upwards: beside Glim's orb, on its row, from 360 wide; above it at 320 | The bar in the card's corner | The bar below 1280, and below 1440 on a screen under 860 tall; the approved card from 1280 on a taller screen |
| 08, the lots | One column of tiles; the tabs are a chip row that scrolls sideways; the band's call is full width | Two columns; title and total over the tabs | Three columns to 1279, four from 1280; 32px gutters. Three across, the ninth lot joins the first screen ("Show 15 more lots"), so it ends in a full row |
| 05, a lot | One column: photo (3:2), thumbnails, title, bid card, history. The big amount is 40; chips 46 tall; Place bid 56; the Max field 16px | Two columns stay: a 340 card beside the photo, so Place bid is on the first screen | A 400 card below 1280, 468 above. Glim's corner closes the page under the history below 1440 |
| 09, bidding power | Title 26; the chips stay four across at 48 tall; the Hold button comes right after the amount, then How the hold works with its steps stacked; Other… is 16px | The column at full width less 32px | The 880 column, with less room above it. Glim's corner closes the page under the trust line below 1440 |
| 07, Glim's panel | A full-screen sheet that follows the visual viewport, so the input stays above the keyboard; 44px controls; chips scroll sideways; 16px input text. On a phone or a touch screen the input takes focus on open only for 05's "Bid on … up to $" | The floating card, 16px under the nav | The floating card, 16px under the nav; under 600 tall it runs from 16px above the bottom |
| 10, My paddle | The band and rows stack; Glim's card under the rows, its controls two 44px halves | Glim's card under the rows | Desktop columns from 1280; below, the hold and Raise share a row over the bar |
| 11, the receipt | One column: thank-you, the receipt, the lots. Download and Email full width; the amount 40. The receipt ends with Glim's note in the same words (the pickup note, or what comes next); the corner closes the page with the orb alone | The same, lots two across | Side by side; lots one column below 1280; Glim's bubble closes the page under the receipt |
| 25b, the print page | The sheet scales to the screen (`FitSheet`); print is untouched, one US Letter page | Same | As drawn |
| 14, the projector | The board flows down a scrolling dark page in reading order; total 56, clock 40, QR 96 | Upright tablets up to 1024 wide flow too, the Sandbox marker at the gutter | The scaled 1440×900 board, as before |
| 12, the control room | The rail first (actions full width, 48 tall), then the ledger; the grid scrolls inside its frame with Paddle pinned, Lots won 152 wide | The rail as a two-column card over the ledger, which shows every column | The same below 1280, so at 1024 the ledger is 960 wide and Status shows; from 1280 the 416 rail beside the ledger. Below 1440 Bidder is 108 (from 100) |
| 28, Insights | One column; the chart redraws at its width; Top lots scrolls inside its widget with Lot pinned | Figures 2 by 2, chart and Top lots full width; Top lots' number columns narrow so Title gets 230 | Below 1280 as on a tablet, Top lots at its desktop columns; from 1280 the drawn grid |

### Decisions

- **The tracks':** a two-row nav instead of a menu button, so every link stays one tap away; navs not sticky; no `viewport-fit=cover` (Next already sends `width=device-width, initial-scale=1`, and pinch zoom stays); the full-screen Glim sheet only on phones; 05 keeps two columns on a tablet so Place bid stays on the first screen; the receipt before the lots on narrow screens; the projector flows rather than shrinking to 4 to 7px type.
- **Integration:**
  - **Glim's corner against the primary actions.** Below 1024 the invitation ("Want me to bid for you?") leaves the orb on its own (`OrbBubble.phone: "none"`): 08's band, 05's "Let Glim bid on this lot" and 10's "Talk to Glim" make the same offer in the page. 09's hint keeps only its question on a phone (`phone: "title"`).
  - **05, 09 and 11 below 1440:** the corner closes the page instead of floating (`CornerOrb placement="page-end"`), as the organizer's already did. On a laptop's first screen it covered 05's "Raise bidding power" and "Let Glim bid on this lot", 09's Hold button (at 1024×768, with no way to scroll it clear) and 11's Download receipt and Email me a copy. At 1440 all are the approved corner.
  - **Room at the end:** 08 leaves 128 to 144px below 1440 (104 on a phone), so its last lots scroll clear of the guide and Glim's bubble.
  - **09's "Continue in this tab"** is a 44px target on a phone, its extra height taken back by margins.
  - **05's Place bid stays below the fold at 375×812** (about 20px). Getting it above would take some 160px, and the photo, the thumbnails or the nav would have to go.
- **The review's** (Nov 10), where they reverse an earlier call:
  - **09's Hold button before the explainer on a phone.** The tracks kept the approved order; at 375×812 the button was 113px below the first screen and at 320×568 two screens down, behind a covered card. It now follows the amount, and How the hold works follows it as reading.
  - **The demo guide's card from 1280,** not 1024: at 1024×768 and 1180×820 the card (575 wide) and Glim's bubble hid the whole second row of lots.
  - **Still no `viewport-fit=cover`.** The review found that every `env(safe-area-inset-*)` resolves to 0 without it. Adding it would need side insets on every gutter for landscape phones, so the comments and `src/ui/README.md` now say the terms are 0 instead.
  - **The demo menu stays non-modal.** Radix's modal mode did not stop the closing tap from opening what was under it in Chrome's touch emulation (it closes on pointerdown, so the click still lands). Instead, a tap or click outside the open menu only closes it (`useDismissOnlyClick` in `RoleMenu`), with a mouse too.

### The review (Nov 10) and its fixes

Phone reviewer: 320×568, 375×812 and 430×932, landscape 568×320 to 844×390, touch and a Pixel user agent. Tablet and laptop reviewer: 768 to 1366, real browser viewports 1024×700, 1280×689 and 1366×657, and iPads. Neither found a change at 1440. All 26 findings held up and were fixed; none was skipped.

| # | Finding | Fix |
| --- | --- | --- |
| 1 | 05's Max field (14px) and 09's Other… (15px) make iOS zoom in on focus | `max-md:text-16` on both |
| 2 | The demo menu runs off a phone held sideways: Reset demo unreachable at 667×375, two more items at 568×320 | Below 1440 the menu and the invite card take Radix's available height and scroll inside (`overscroll-contain`). At 1440 the open menu is pixel-identical to before |
| 3 | 09's Hold button a screen or more below the fold on a phone | The explainers take `max-md:order-1`: the button ends at y 435 at 375×812 and 479 at 320×568 |
| 4 | The guide bar sat 88px up on every phone, over the chips at 320 | From 360 wide it sits beside the orb, centred on its row; at 320 it stays above |
| 5 | Times split from AM/PM (10 at 430, 11 at 320) | The time in no-break spaces (`keepTogether`; `receiptDateParts` for 11) |
| 6 | " · " lines wrapping inside a name or with a leading dot (05's donor line, 16, 16c and not-found's fine print) | They wrap only after a separator, each part whole and the dot with the part before (`wrapAtSeparators`; 05's line no longer balanced) |
| 7 | Single words alone: 07's status ("…held with / PayPal"), 09's raise lede ("not / a charge.") | `max-md:text-balance` on 07's status; 09's lede puts each sentence on its own line on a phone |
| 8 | The sheet focuses its input on open, so Android raises the keyboard over the greeting | On a phone or a touch screen the input takes focus only for 05's prefill, which waits for an amount |
| 9 | The safe-area insets do nothing (no `viewport-fit=cover`) | Kept no cover (see Decisions); the comments and README corrected. `src/app/layout.tsx` unchanged |
| 10 | 11's pickup note pushed past every lot on a phone | Below 1024 the receipt card ends with the same words (`ReceiptNote`), and the corner shows the orb alone |
| 11 | The ledger's Bidder and Lots won and Top lots' Title cut short on a phone | Phone widths: Lots won 152, Bidder 108 below 1440; Top lots below 1024: Lot 56, Title at least 170, Estimated value 104 with its header on two lines, Bids 64, Paddle 80, Glim 64. 1440's columns are unchanged |
| 12 | The tap that closes the demo menu also opened the lot under it (on HEAD too) | That tap or click only closes the menu |
| 13 | 09's bubble on the Hold button at 1024×768, for good | The corner closes the page below 1440; the 120px end padding below 1024 went |
| 14 | 05's bubble and orb on "Raise bidding power" and "Let Glim bid on this lot" on laptops | The same, below 1440 (it was phones only); the 128 and 112px end padding went |
| 15 | The docked guide and Glim's bubble hide 08's second row on a landscape iPad | The bar below 1280, and on screens under 860 tall below 1440 |
| 16 | Glim's card reaches y 16 on a laptop, over the nav, bidding power and the paddle pill | Below 1440 it stops 16px under the nav: `max-h` 100dvh−196 from 1024, 100dvh−247 below (the two-row nav), 100dvh−100 in a short window from 1024 |
| 17 | 12's ledger beside the 360 rail at 1024 cut off Status (Failed, Retry) | The rail stands above the full-width ledger below 1280; the ledger's heading row stays one line from 1024. 28's chart and Top lots take the full width below 1280 too |
| 18 | 05's donation line at 768 split "Estimated value / $600" | As 6 |
| 19 | 05's max line left "$420." alone at 1024 to 1279 | "up to $420." in no-break spaces |
| 20 | The invitation bubble on the lots and 10's rows of an upright tablet | Hidden below 1024, as on a phone |
| 21 | 14 on a tablet: the Sandbox marker 12px in from the gutter, "PayPal." alone | No margin on the marker in the flowed layout; the trust line balanced |
| 22 | 14 at 1024×1366 got the scaled board with 7.5px labels | The flow takes upright screens up to and including 1024 wide |
| 23 | At 1366 the paddle mark (x 32) and the content (x 43) don't line up | The navs' gutter is `max(32px, 50% − 640px)` below 1440 |
| 24 | 09's captions at 768 broke "All / $500" | `text-pretty` instead of `text-balance` there |
| 25 | Top lots at 768: Title at its 128 minimum, about ten characters | As 11; Title gets 230 at 768, and every column shows |
| 26 | 08 at 1024 to 1279: the first eight lots end in a row of two | The ninth lot joins them there (`CatalogGrid`'s `rowFiller`), and the button counts 15 |

The tablet reviewer also noted that `src/server/paypal/window-page.ts` gained a media query in this work: it is in the page's template only (the one-column layout of design/17 on a phone).

### Checks

- **Unit and build:** typecheck, lint and `rm -rf .next && npm run build` pass. `npx vitest run`: 165 files, 1,578 tests (two new, for `keepTogether` and `wrapAtSeparators`; `receiptDateParts` joins an existing one).
- **Responsive specs** (`tests/e2e/responsive-*.spec.ts`, every width, no sideways overflow, no clipped text, thumb-sized primary actions at 375):

  | Spec | Tests | Server |
  | --- | --- | --- |
  | responsive-shell | 7 | live |
  | responsive-lots | 18 | live |
  | responsive-glim | 9 | live |
  | responsive-organizer | 3 | live |
  | responsive-fix (new: each review fix, at the widths it was found at) | 11 | live |
  | responsive-paddle | 8 + 9 | the paddle moment, then the closed moment (frozen) |

  48 of 48 on the live server at 2 workers, then 8 and 9 (17 skipped for the other moment). The fixes changed what three specs expected: responsive-glim (05 and 09 close the page below 1440; the invitation and 11's bubble hidden below 1024; a page shorter than the screen), responsive-shell (the guide is the bar at every width in WIDTHS; the nav lines up with the content from 1024) and responsive-organizer (the ledger pins only on a phone; the rail above it below 1280; Top lots pins only on a phone).
- **golden-path-phone.spec.ts and golden-path.spec.ts** on the real tick, on a fresh database: 2 of 2 in 1.7 minutes.
- **The 1440 specs:** fidelity, guest-pages, lot-drawings and healthz 35 of 35; glim-fidelity 1 of 1 and power-fidelity 1 of 1 (run one after the other: power-fidelity takes Jamie's hold away, which glim-fidelity needs); paddle-receipt-projector 3 of 3; control-room- and insights-fidelity 2 of 2. The live group on a fresh database: 70 passed, 1 skipped (the sandbox buyer card).
- **Fidelity numbers** (unchanged): 08 1,075 and 05 4,149 against the Day 1 PNGs, 0 against the integrator's captures; 09 1,073 (Day 2) and 1,401 (mockups/09); 12 3,290 (2,964 in the nav, 326 in the corners); 28 57,787; 07's nine part captures 0 from the glim track's pre-change captures; 10 0 and 14 differing only in the port, against the paddle track's.
- **The 1440 A/B** against the integrator's HEAD captures, same seeds and frozen clocks: 13 catalog-moment states (16, 16b, 16c, not-found, 05 for lots 03 and 07 and the missing lot 99, 08 and 08 filtered, 10, 09, the PayPal window's start and cancel pages) and 11 closed-moment states (16b, 05, 08, 10, 09, 12, 28, 11 for 119, 142 and the never-held 302, 25b), 0 pixels each; the open demo menu 0 pixels inside the menu; 14 only in its join line and QR.
- **The sweep:** every page state at 320, 375, 430, 768, 1024, 1280, 1366 and 1440, run again after the fixes (532 captures, then the touched scenarios again): no overflow, no clipped text, no console errors on a warm server. Script: the integrator's scratchpad `responsive/sweep/sweep.mjs`; the fixer's captures are in the scratchpad's `responsive/fix/sweep/`.

### Still imperfect

- **Phones:**
  - The two-row nav is 119px, about 15% of an 812 screen; on a demo gala at 320 the Sandbox marker wraps under the status pill (143px).
  - 05's Place bid sits about 20px below the fold at 375×812.
  - The orb floats over 08's and 10's rows while scrolling, as any fixed element does; each page leaves room so its end scrolls clear. The guide bar does the same at the bottom left.
  - The open demo guide covers the lots until it is closed.
  - 25b is a 0.42× preview, readable only zoomed, and shows unscaled for a moment before hydration.
  - At 320, long projector titles wrap to three or four lines; the panel header hides its orb and wraps the status, which balances as "Not bidding yet · $500 / held with PayPal".
  - The page behind Glim's sheet is not scroll-locked; the iOS keyboard path is in code but not tried on a device.
  - The safe-area terms are 0 (no `viewport-fit=cover`); on an iPhone with Safari's toolbar collapsed the 56px orb's lower 18px reach into the home indicator's zone.
  - The ledger and Top lots still scroll sideways on a phone; Status and the money columns are a swipe away.
- **Tablets:** home leaves space right of its 544 panel; the 400px Glim card covers about half the page at 768; 28's black Limits kept card is tall and mostly empty beside Hold utilization.
- **Laptops:** at 1280×800 the guide bar still sits on the first price of 08's second row, and Glim's bubble on the last lot's title, on the first screen; at 1366 the fixed guide and orb keep 32px from the window's edge while the content is 43px in; 11's single-column lot tiles are large below 1280.
- **Landscape phones** at 768 wide and up (812×375) get the floating Glim card, which covers the nav there, and the scaled projector board.
- **Not tried:** Safari and real devices. The layouts use `text-wrap: balance` and `pretty`, and 11 uses `display: contents` on `main` below 1024.

## Known gaps

- **Not run yet:** Safari, and the autopilot beat in a normal desktop Chrome window at full width.
- **The approved window closes after 3 s, and it is reused by name.** A second hold pressed within those 3 s can have that close land on its start, and 09 then shows frame 5 ("Continue to PayPal in this tab"). Only a press within seconds of an approval meets it. hold.spec now waits it out.
- **A director backlog delays the rivals.** Demos started on a server with `ENGINE_ENABLED=false` keep their queued director jobs. When an engine-on server later reads the same database, it works through hundreds of overdue jobs first, and the rivals came 60 s late. Use a fresh database for the real-tick spec.
- **The nav and a refusal can show different figures (Day 2 #20).** With the autopilot's limits, 05 reads "You have $0 left of $500" while the nav reads $190 / $500, because the refusal reserves Glim's limits.
- **Keyless Glim:**
  - Recorded mode knows seven chat sentences. Anything else gets "I can only replay recorded answers right now. You can still bid yourself."
  - The recorded autopilot why is the earlier live sentence, not 21's example.
- **An unknown slug answers HTTP 200** with 16c's page.
- **`/api/demo` still takes `firstName`.** The home form sends none, and the API keeps it for the specs.
- **E2E:**
  - Specs are not in CI.
  - On a long-lived database with `ENGINE_ENABLED=false`, demo lots past their close stay open, and the engine closes overdue lots 200 at a time. Once over 200 are due, the creator's Close next lot answers "24 lots are still open" and entry.spec's role menu test fails (on HEAD too). A fresh database passes.
  - hold.spec's "flips the nav in another tab" can miss its 5 s when three copies run at once (on HEAD too). It passes alone and in the full file at 2 workers.
  - Several dev servers at once can use up Postgres's connections, and the integration tests then fail with "too many clients". Stop them before `npx vitest run`.
  - Delete the dev server's build folder before each `next dev`.
  - `next dev` adds its `NEXT_DIST_DIR` to `tsconfig.json`'s include list. Take those lines out before committing.
- **Small leftovers:**
  - Four spinners draw the same ring: `power/icons`, `glim/marks`, `organizer/Spinner` and `paddle/icons`.
  - The footer line "Riverside Shelter Gala · runs on Fairhold" is only on 16b, which is the one board that draws it.

## Run it locally

`.env.local` holds your real keys, and values set in the shell win over it. For a keyless run:

```sh
export PAYMENTS_MODE=simulated GLIM_MODE=recorded
export PAYPAL_CLIENT_ID=""
export PAYPAL_CLIENT_SECRET=""
export ANTHROPIC_API_KEY=""

npm run db:start && npm run db:migrate && npm run db:seed   # the seed prints FREEZE_CLOCK_AT
npm run typecheck && npm run lint && npx vitest run
rm -rf .next && npm run build

# Live behavior: no frozen clock, no tick
NEXT_DIST_DIR=.next-local npx next dev -p 3456
DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test \
  tests/e2e/live.spec.ts tests/e2e/hold.spec.ts tests/e2e/glim-panel.spec.ts tests/e2e/control-room.spec.ts \
  tests/e2e/lot-states.spec.ts tests/e2e/insights.spec.ts tests/e2e/entry.spec.ts tests/e2e/healthz.spec.ts

# The approved look: seed with --date=2026-11-07 and freeze at what it prints
FREEZE_CLOCK_AT=2026-11-08T04:58:00.000Z npx next dev -p 3456
FREEZE_CLOCK_AT=2026-11-08T04:58:00.000Z PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test \
  tests/e2e/fidelity.spec.ts tests/e2e/guest-pages.spec.ts tests/e2e/lot-drawings.spec.ts tests/e2e/healthz.spec.ts
# glim-fidelity and power-fidelity need today's seed (no --date), its FREEZE_CLOCK_AT, and the server's
# SESSION_SECRET in the spec's environment; power-fidelity mutates the fixture (it takes away the hold
# glim-fidelity needs), so run glim-fidelity first or alone, and reseed afterwards.
# paddle-receipt-projector: --moment=paddle --date=2026-11-07. control-room- and insights-fidelity: --moment=closed.

# Below 1440: on the live server; responsive-paddle on its own seeded moments (see its header)
DATABASE_URL=<the server's> PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test \
  tests/e2e/responsive-shell.spec.ts tests/e2e/responsive-lots.spec.ts tests/e2e/responsive-glim.spec.ts \
  tests/e2e/responsive-organizer.spec.ts tests/e2e/responsive-fix.spec.ts

# The whole path on the real tick, on a fresh database, at 1440 and on a phone
ENGINE_ENABLED=true npx next dev -p 3456
ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 GOLDEN_PATH_SHOTS=/tmp/golden \
  npx playwright test tests/e2e/golden-path.spec.ts tests/e2e/golden-path-phone.spec.ts
# The same with live Claude: start the server with GLIM_MODE=live and ANTHROPIC_API_KEY from .env.local.
```

The control room is at `/e/<slug>/organizer`, and Insights is at `/e/<slug>/organizer/insights`. Only the demo's creator can open them. In a browser, use the paddle pill's Organizer view.
