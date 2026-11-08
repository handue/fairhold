Owner area: Glim. The claude-opus-5-5 proposal call, the allocator, the validator, the amount guard and the autopilot's decision step; nothing here can bid or move money.

- `turn.ts` runs one guest message: caps, state snapshot, model call, one retry for a rejected proposal, the clamp, the amount guard. Start here.
- `prompt.ts` (system prompt, snapshot), `tools.ts`, `client.ts` (live model, request, failures), `recorded.ts` (GLIM_MODE=recorded, fixtures in tests/fixtures/glim/recorded).
- `allocator.ts`, `validator.ts`, `amountGuard.ts`, `cards.ts`, `caps.ts`, `copy.ts` (every code-written line).

The caller supplies a `GlimState` (types.ts; `loadGlimState` in src/server/queries/glim-state.ts reads it from Postgres, with commitments from the engine's own calculation) and the paddle's stored transcript (`glim_transcript`, one row per API message), then persists what `runGlimTurn` returns: append `transcriptAppend` verbatim (jsonb, never edited), insert `rejections` into glim_actions, store `card`/`proposal` as a proposed glim_plans row, and record `model`, `usage` and `latencyMs` on chat_messages. Serialize turns per paddle.

Autopilot (`autopilot/`, `mandate.ts`; spec `docs/planning/glim-autopilot.md`): after Start bidding, Glim decides again on its own inside the guest's mandate (the budget and caps they named, the plan lots and backups, the lots they ruled out). `autopilot/options.ts` works out what is possible, `autopilot/decide.ts` lets Claude choose with structured output and no tools (or `autopilot/rule.ts` decides), `autopilot/validate.ts` checks every rule, and `autopilot/copy.ts` writes the card. Everything here stays pure: `src/server/plans` reads the database, applies the change through the engine's `createLimits` and stores the records. ESLint keeps PayPal, the database and the engine's actions out of this folder.

Chat callers pass `autopilot` to `runGlimTurn` (false when `GLIM_AUTOPILOT=off`), store a proposal with `storeProposedPlan` (`src/server/plans/proposals.ts`) and confirm it with `confirmPlan`.

`npm run glim:spike` runs the golden sentence, `npm run glim:spike -- --autopilot [scenario] [--record]` one autopilot decision; `npx vitest run tests/unit/glim` runs the tests.
