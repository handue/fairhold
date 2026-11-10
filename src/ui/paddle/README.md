Owner area: screen 10, My paddle (mockups/10, design/23), from `src/server/queries/paddle-view.ts`.

- `PaddleScreen`: the money panel, My lots and Glim's activity. Rows fold from the stream like 08's; Glim's plan and feed, a raise's PayPal window and the close refresh the server's page (`changesPaddlePage`).
- `GlimActivity`: 10's card. Not bidding yet (Talk to Glim), On duty (Edit plan, Pause), Paused (Edit plan, Resume in ink with a lime mark). The two-line rule of design/21 when the running plan was armed, or before any plan when a card would arm the autopilot; 10's one line for a plan with no mandate.
- The page sends a guest with no bidding power to 09, and everyone to 11 once bidding has closed (decision B3, design/27).
- `icons.tsx`, `time.ts` (lot close times to the nearest minute) and `text.ts` (`keepLastWords`) are shared with `receipt/` and `projector/`.
- Below 1440 (max-* variants only, so 1440 is unchanged): from 1280 the money band's hold and Raise share a row over the bar and each lot row puts its pill and timer under the words; below 1024 Glim's card goes under the rows; on a phone the band and rows stack, the controls become two 44px halves. `tests/e2e/responsive-paddle.spec.ts` checks every width.
