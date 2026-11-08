Owner area: plans. The one writer of Glim plans, and the autopilot's scanner and runs; no PayPal.

- `apply.ts`: `applyAutopilotChange`, `prepareAutopilotRaise` (autopilot), `confirmPlan`, `skipLot` (the guest). Each is one transaction (`withPlanTransaction`, `db.ts`): the paddle's running plan row, then the lots it touches in id order, then the engine through `createTransactionStore`, then the records. The engine change and its records commit together or not at all.
- `proposals.ts`: a proposed plan row with the card the guest saw (`proposal.card`); `confirmPlan` reads it back with `planCardSchema`.
- `scan.ts` (`scanFacts`, `scanClosingSoon`, `claimDue`, `releaseClaim`, `requeueClaim`), `context.ts` (`loadAutopilotRead`), `run.ts` (`runAutopilot`, `autopilotGate`), `task.ts` (`createAutopilotTickTask`, registered in `src/instrumentation.ts`), `usage.ts` (`tokensToday`, the one daily count chat and autopilot share), `runs.ts` (run rows and the "Deciding…" rows).

The decision itself is pure and lives in `src/server/glim/autopilot/` (options, validator, rule, brief, copy); the model never gets a tool, and every change goes through `createLimits`, which refuses anything over the hold. Spec: `docs/planning/glim-autopilot.md`. Tests: `npx vitest run tests/integration/plans tests/unit/glim/autopilot`.

Pause and resume (Day 3) must update `glim_plans.status` and `version` in their own transaction before calling `pauseLimits` or `resumeLimits`; that is what fences an autopilot decision in flight.
