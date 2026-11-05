Owner area: Glim. The claude-opus-5-5 proposal call, the allocator, the validator and the amount guard; nothing here can bid or move money.

- `turn.ts` runs one guest message: caps, state snapshot, model call, one retry for a rejected proposal, the clamp, the amount guard. Start here.
- `prompt.ts` (system prompt, snapshot), `tools.ts`, `client.ts` (live model, request, failures), `recorded.ts` (GLIM_MODE=recorded, fixtures in tests/fixtures/glim/recorded).
- `allocator.ts`, `validator.ts`, `amountGuard.ts`, `cards.ts`, `caps.ts`, `copy.ts` (every code-written line).

The caller supplies a `GlimState` (types.ts; `loadGlimState` in src/server/queries/glim-state.ts reads it from Postgres, with commitments from the engine's own calculation) and the paddle's stored transcript (`glim_transcript`, one row per API message), then persists what `runGlimTurn` returns: append `transcriptAppend` verbatim (jsonb, never edited), insert `rejections` into glim_actions, store `card`/`proposal` as a proposed glim_plans row, and record `model`, `usage` and `latencyMs` on chat_messages. Serialize turns per paddle.

`npm run glim:spike` runs the golden sentence; `npx vitest run tests/unit/glim` runs the tests.
