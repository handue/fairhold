Owner area: Glim's chat, the server side of the 07 panel (`src/ui/glim`, routes in `src/app/api/glim/[slug]`). It stores what `runGlimTurn` returns and posts what the engine did; nothing here bids or reaches PayPal.

- `switch.ts`: **`PLAN_CARDS_ARM_AUTOPILOT`, the one switch that lets a plan card arm the autopilot. It is off until the user approves V1 (design/21).** Off, a card carries `autopilot: false`: Start bidding stores no mandate and arms nothing, and the snapshot tells Glim so.
- `lock.ts`: one turn at a time per paddle, a Postgres advisory lock on a connection of its own. A paddle has one turn running and one waiting; a further message gets `glim_busy` at once, so one guest cannot use up the 16 connections. `turn.ts`: `runChatTurn`, one message end to end, stored in one transaction (chat_messages, glim_transcript verbatim, rejections in glim_actions, a proposal through `storeProposedPlan`). A line that needed no model call (the caps, an empty message) is not stored. `stream.ts`: the route's NDJSON answer.
- `event-cards.ts`: the deterministic sentences, pure. `event-card-sync.ts`: `syncEventCards` turns the engine's facts into glim_actions rows, cards and a `chat_card` row on the paddle's channel; `glim_actions.source_event_log_id` makes it idempotent. It skips the opening bid of a limit listed in `autopilot_finished.limitIds`, since the autopilot's own card tells it. `task.ts`: the tick task, which belongs ahead of the autopilot's.
- `actions.ts`: Start bidding, Edit, Skip, Pause, Resume, through the one plan writer (`src/server/plans`). `view.ts`: `loadChatView`, the panel's whole picture, built fresh with the card's live status text. `types.ts`: what the browser reads.

Routes, all session-bound and answering the new `ChatView` unless noted: `GET /api/glim/[slug]`; `POST .../messages` (NDJSON); `POST .../plans/[planId]/confirm`; `POST .../plans/[planId]/edit`; `POST .../lots/[number]/skip`; `POST .../pause`; `POST .../resume`.

From anywhere in the browser: `openGlim()` opens the panel, `openGlim({ prefill: "Change my plan: " })` is Edit plan.

Tests: `npx vitest run tests/unit/chat tests/integration/chat`.
