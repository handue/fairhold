# Fairhold

Fairhold runs charity silent auctions. Each guest puts bidding power on hold with PayPal (an authorization, not a charge) and is charged only for the lots they win. Guests bid themselves or let Glim, a bidding agent built on Claude, bid for them inside limits they set.

**Hosted demo: https://fairhold.onrender.com** (PayPal sandbox, no real money. You are the one real guest among 85 simulated guests.)

> AI decides inside a mandate; deterministic code enforces the mandate and the hold.

| Who | What they do |
| --- | --- |
| The guest | Sets the rules and approves every hold in a PayPal window |
| Glim (Claude, `claude-opus-5-5`) | Turns a sentence into a plan, and picks a move when the auction changes |
| Fairhold's code | Checks every decision and places every bid, never past the hold |
| PayPal | Holds the money, captures each winner's total, releases the rest |

Glim has no tool that moves money.

## Try it in five minutes

**You need a PayPal sandbox buyer login** for the hold. It is in the Devpost submission's testing instructions. If the host has set one up, the home page also shows a "PayPal sandbox buyer" card with the email and a Copy button for the password. Without a login the hosted walkthrough stops at step 2; the [local run](#run-it-locally-no-keys) needs no keys and simulates the hold.

**Timing:** Glim's move needs Wine Tasting, the backup, still open with 90 seconds to spare, and it closes 12 minutes after you start. So press **Start bidding** (step 6) within about 7 minutes and **Close bidding now** (step 8) before about 10. **Running late?** Before step 6, open the demo menu from your paddle pill and press **Add 10 minutes**: every open lot then closes 10 minutes later. If you let Wine Tasting run past about 10½ minutes, simulated guests bid on it too, and your totals in steps 8 to 10 come out above $310.

1. Open https://fairhold.onrender.com and press **Start a demo gala**. You get a private 25-minute gala with 24 lots. You are Jamie, paddle 142, and also the organizer. The **Demo guide** card on the lots page follows the same path in five steps.
2. Press the nav's **Bidding power** pill ("Not set"), keep $500, and press **Hold $500 with PayPal**. Sign in with the sandbox buyer in the PayPal window and approve. The PayPal page may say "Pay with PayPal", but approving only authorizes the $500 hold. If no PayPal window appears, press **Continue in this tab** under "Didn't open?" (or **Continue to PayPal in this tab** if your browser blocked the popup). The nav now reads **$500 / $500**, and nothing has been charged.
3. On Lot 07, **Chef's Table Dinner for Four**, press **Place bid** ($320). The nav drops to $180 / $500.
4. On Lot 09, **Private Wine Tasting for Six**, press the heart (**Save to my lots**). It becomes Glim's backup. Without a backup the rivals in step 7 still bid, but Glim has nowhere to move the money, so the move does not happen.
5. Open Glim with the lime orb at the bottom right (its label is "Chat with Glim") and send `$500. I really want the chef's dinner. Spa only under $120.` The **My plan for you** card shows Chef's Table up to $380 and Spa Day up to $120. Its **On my own** block says what Glim may do without asking. It lists Wine Tasting as a backup ("You hearted it") and ends "Never past $500 in all, and Spa Day up to $120."
6. Press **Start bidding**. Nothing is bid before this. Glim bids $90 on Spa Day.
7. Keep the panel open for one to two minutes. A simulated rival bids $360 on Chef's Table and Glim raises to its $380 limit. Then a rival bids $400. With no tap from you, Glim posts: **"I moved the $380 left to Wine Tasting. I bid $220 for you and will go up to $380."** The card adds Claude's one-sentence reason, your rules and a **Skip Wine Tasting** button.
8. Close the Glim panel (the × at its top right). Then open the demo menu from your paddle pill (**142 Jamie**) and press **Close bidding now**. Fairhold opens your receipt, which reads "Receipt pending" and "$310 to pay with PayPal".
9. In the same menu, choose **Organizer view**. The control room checks every winner against their hold and every Glim bid against its limit, and asks PayPal whether each real hold is still valid. Press **Charge _N_ winners**. _N_ includes the simulated winners, who settle in the database only. Your hold is captured for $310 and the other $190 is released.
10. Press **See your receipt**. It is stamped "Sandbox demo · not a tax document", and its PayPal transaction ID is the sandbox capture ID. **Projector** and **Insights** are in the organizer nav.

On the hosted site, live Claude writes Glim's chat replies and the autopilot cards' one-line reasons, and picks step 7's move from the moves code allows. Claude may also keep the plan or set a lower limit, so your run can read differently. Code checks every pick and writes each card's main line and every amount from what the engine did. Limits: holds $25 to $1,000, 5 new galas per address per hour, 25 running at once. Each gala's holds are voided and its data deleted 6 hours after it starts.

## What's interesting

### Bidding power is a PayPal authorization

- **Hold, not charge.** Pressing Hold creates an Orders v2 order with `intent: AUTHORIZE` and `user_action: CONTINUE`. Fairhold authorizes it when the guest comes back, and that authorization is their bidding power.
- **One rule in the engine.** For every paddle, the sum of its commitments never exceeds its authorized hold. Bids never call PayPal. Each bid is checked against the stored hold in the transaction that writes it.
- **A raise is a second hold.** The new authorization takes over only if it is larger and covers what the paddle already owes. Then the old one is voided.
- **Settlement.** One capture per winner for the won total, with `final_capture: true` so PayPal releases the rest. Every real hold that won nothing is voided.

### Glim's autopilot

The **mandate** is the plan card the guest confirmed with Start bidding: a budget, ranked lots with caps, backups and excluded lots. Skip, Pause or the guest's own maximum narrows it at once. Widening it takes a new confirmed card.

```
a rival bids $400 on Chef's Table
 -> engine:  Glim's $380 limit is used up                   (trigger)
 -> code:    lists the moves the mandate allows; none means no model call
 -> Claude:  picks one, with a one-sentence why             (JSON schema output, no tools)
 -> code:    rules R0-R10, then one transaction through the engine's
             all-or-nothing createLimits, which refuses anything over the hold
 -> card:    "what" written by code from the engine's result, "why" from Claude after a filter
```

- **Triggers:** a used-up limit, a lot won or lost, a higher hold landing, or a plan lot 90 seconds from closing.
- **Rules:** only lots in the mandate, no maximum above the guest's cap, a live limit is never lowered to pay for a lot the guest ranked lower (money a used-up or lost lot frees can go to a backup), and the total stays inside the named budget and the hold.
- **The why** must be one line of at most 140 characters with no numbers, no amounts and no promises. Otherwise the card shows a template line.
- **Fallback:** a deterministic rule decides when Claude is slow (15 s), errors, hits a usage cap or picks a move that breaks a rule, and when the lot closes within 25 seconds. The API retries a refused call on a fallback Claude model; if that one refuses too, the rule decides. The rule never lowers a limit and never prepares a raise.
- **Raises:** Glim can only prepare an offer ("Approve $600 in PayPal"). The guest approves the new hold in PayPal, and the server reads the amount from the stored offer, not the request.

### Why Glim has no PayPal tools

- **No model call can move money.** Glim's chat tools (`propose_plan`, `propose_change`, `suggest_hold_amount`) only make cards for the guest to confirm, and code sets every maximum. The autopilot call has no tools.
- **The build enforces it.** ESLint forbids `src/server/glim` from importing PayPal code, the database or the engine's write actions, by alias or relative path, along with `pg` and `@paypal/*` ([eslint.config.mjs](eslint.config.mjs)). CI runs lint on every push to main and every pull request.
- **Amounts are checked.** A dollar figure in Glim's text that is not in the validated plan or the auction's figures replaces the reply with a template.
- **The calls need checks.** Authorize, capture, void and reauthorize belong in deterministic code with idempotency keys. PayPal's Agent Toolkit 1.11.0, which we looked at, creates CAPTURE orders and has no authorization tools.

## How it works

```
Browser: guest, organizer, projector
  |  pages and JSON routes                 ^  server-sent events (5 s polling fallback)
  v                                        |
Next.js app, one Render web service
  src/server/glim        prompts, tools, allocator, validator, autopilot  ---> Claude API
  src/server/plans       checks Glim's decisions, applies them through the engine
  src/server/engine      every bid goes through here
  src/server/director    85 simulated guests, bidding through the same engine
  src/server/holds, paypal, settlement   holds, raises, charges, webhooks  ---> PayPal sandbox
  1-second tick in one process (Postgres advisory lock): closing, rivals, autopilot, charges
  |
  v
Postgres 16 (Drizzle)        Render cron every 15 min ---> POST /api/cron/sweep
```

| # | PayPal call (sandbox; 1-6 through `@paypal/paypal-server-sdk`, 7 as a direct REST call) | When |
| --- | --- | --- |
| 1 | `POST /v2/checkout/orders`, `intent: AUTHORIZE`, `user_action: CONTINUE` | The guest presses Hold |
| 2 | `POST /v2/checkout/orders/{id}/authorize` | The guest returns from PayPal (a webhook is the backstop) |
| 3 | `GET /v2/payments/authorizations/{id}` | Before charging: CREATED, unexpired, covers the won total |
| 4 | `POST .../authorizations/{id}/reauthorize` | A winner's hold past its 3-day honor period, non-demo events only |
| 5 | `POST .../authorizations/{id}/capture`, `final_capture: true` | One per winner |
| 6 | `POST .../authorizations/{id}/void` | Holds that won nothing, holds a raise replaced, demo cleanup |
| 7 | `POST /v1/notifications/verify-webhook-signature` | Every webhook delivery |

- **Idempotency:** every payment POST carries a `PayPal-Request-Id` derived from the operation and the hold or charge (the webhook check's id comes from the delivery itself), so a retry replays PayPal's answer. The capture's invoice ID never changes, so a second charge is refused.
- **Retries:** a charge with no clear answer (a timeout or a 5xx) is tried 5 times with the same request id, 2, 8, 30 and 120 s apart; a decline fails at once. Either way the organizer can press Retry. Webhooks only move state forward.
- **The sweep** expires old holds, retries voids, and deletes demo galas after 6 hours.
- **Live stream:** each change writes an `event_log` row and a Postgres NOTIFY, sent to browsers as server-sent events.
- **Proven on the sandbox:** `npm run paypal:lifecycle` passed 29 of 29 checks, covering authorize, a mocked decline, capture, replay, void and raise ([docs/paypal-lifecycle.md](docs/paypal-lifecycle.md)).

Each top-level folder under `src/server/` has a README. The autopilot spec is [docs/planning/glim-autopilot.md](docs/planning/glim-autopilot.md).

## Honesty notes

- **Sandbox only.** Payments use the PayPal sandbox, and no real money moves.
- **Simulated guests.** Each demo gala has 85 simulated guests, and a director script places their bids, including the rivals'. The rivals are timed so the autopilot moment comes within minutes. Their holds and charges exist only in the database, and the control room and Insights say so.
- **Made-up charity.** Riverside Animal Shelter, its 501(c)(3) status and its EIN are placeholders. "Email me a copy" opens a draft in your mail app; Fairhold sends no email.
- **Reauthorization** is tested against a fake PayPal but not yet run on the sandbox: the test holds do not pass their honor period until Nov 11 at 9:09 PM PST. Demo galas last 6 hours and never need it.
- **Not yet recorded on the hosted site:** a verified webhook delivery and a sweep run. Both have automated tests.
- **Browser tests** are not in CI. They were run by hand, and the results are in [docs/status/day3.md](docs/status/day3.md).
- **Not tried** on Safari or real phones. Layouts were checked in Chrome from 320 to 1440 px wide.
- **Two figures can disagree:** a lot page's "You have $X left" counts Glim's limits as reserved, so it can read $0 while the nav reads $190 / $500.

## Run it locally (no keys)

You need Node 24 (`.node-version`). There is no Postgres to install: `db:start` runs Postgres 16 from the `embedded-postgres` npm package.

```sh
npm install
npm run db:start                  # Postgres 16 on port 54329, data in .pgdata/
npm run db:migrate
ENGINE_ENABLED=true npm run dev   # http://localhost:3000
```

Open http://localhost:3000 (not `127.0.0.1`) and press **Start a demo gala**.

- **`ENGINE_ENABLED=true`** starts the tick: rivals, Glim's own moves, lots closing and charges in the background. It defaults to `false`, and without it nothing moves on its own.
- **Keyless defaults:** simulated payments (instant approval), recorded Glim and placeholder secrets, with no env file.
- **Recorded Glim** replays seven chat sentences, ignoring case, quote style and spacing. The walkthrough's sentence is one of them. The others: "$600. Get me the chef's dinner, and the spa if it stays under $120.", "Change my plan: drop the spa.", "Can you also get me the cabin?", "How does a hold work?", "How am I doing?" and "What can you do?".
- **`npm run db:seed`** is optional. It seeds the fixture at `/e/riverside-shelter-gala` for the screen tests.
- **Late rivals:** galas started with the engine off leave queued bids behind. If rivals come late, run `npm run db:stop`, delete `.pgdata/`, then run `db:start` and `db:migrate` again.

**Sandbox keys:** copy `.env.example` to `.env.local`.

- `PAYMENTS_MODE=sandbox` with `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` turns on the PayPal sandbox.
- `GLIM_MODE=live` with `ANTHROPIC_API_KEY` turns on live Claude.
- `PAYPAL_WEBHOOK_ID` is optional. Without it the webhook route answers 503.
- `DEMO_BUYER_1_EMAIL` and `DEMO_BUYER_1_PASSWORD` show the buyer card.

`render.yaml` is the Render Blueprint (web service, Postgres 16, sweep cron). Migrations run before each deploy, and a commit deploys only after CI passes.

**Tests**

```sh
npm test             # Vitest: 165 files, 1,578 tests, all passing (needs npm run db:start)
npm run lint && npm run typecheck
```

- **Vitest** runs unit and integration tests without keys. Each integration file gets its own freshly migrated database.
- **Playwright** has 24 spec files in `tests/e2e/` and uses your installed Google Chrome. The walkthrough above runs at 1440×900 and on a phone:

  ```sh
  PAYMENTS_MODE=simulated GLIM_MODE=recorded ENGINE_ENABLED=true npx next dev -p 3456
  ENGINE_ENABLED=true PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test \
    tests/e2e/golden-path.spec.ts tests/e2e/golden-path-phone.spec.ts
  ```

  The other specs each need their own server setup (a seed, a frozen clock, `ENGINE_ENABLED=false` or the server's `DATABASE_URL`); see their headers and [docs/status/day3.md](docs/status/day3.md).
- **CI** (`.github/workflows/ci.yml`) has two jobs on every push to main and every pull request: "Lint, typecheck, test, build" and "Secret scan" (gitleaks).

## Built with

Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, Radix UI · PostgreSQL 16 with Drizzle ORM · PayPal Orders v2 and Payments v2 (sandbox) through `@paypal/paypal-server-sdk` · Claude (`claude-opus-5-5`) through `@anthropic-ai/sdk` · AG Grid Community (the control room's ledger and Insights' top lots) · Vitest, fast-check, Playwright · Render · gitleaks

## License

[MIT](LICENSE)
