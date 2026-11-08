Owner area: read models. Server-side queries the pages and route handlers render (catalog, paddle overview, ledger, receipt, projector).

- `catalog.ts` (08) and `lot.ts` (05) read a page's rows from a `GuestReadSource`, with the stream position they include every row up to, read first (`getCatalogSeed`, `getLotDetailSeed`).
- `catalog-view.ts`, `lot-view.ts` and `viewer-summary.ts` build typed views (`types.ts`) from those rows. They are pure, so the server and the browser run the same code.
- `live-records.ts`: `foldStreamRows` keeps a page's rows current from the stream in the browser. It only says which row changes which field; every rule stays in the view builders. `tests/integration/queries/live-fold.test.ts` checks on Postgres, for random sequences of real actions, that the fold lands where a fresh read does.
- `favorites.ts`: the heart. A guest's own list, not auction state, so it does not go through the engine. `lot-ref.ts` finds a lot by slug and number for the routes.
- `postgres-source.ts` reads those rows in SQL over the scope map's column names (the names the seed writes), with ids as text, amounts as integers and times as epoch milliseconds.
- `source.ts` picks the source: Postgres, or outside production the UI fixture (`UI_FIXTURE=riverside`) and a frozen clock (`FREEZE_CLOCK_AT`) for visual checks.
- `glim-state.ts` builds Glim's `GlimState` for one paddle from the same reads plus the engine's `getBiddingPower` and `getCommitments`, so Glim plans within exactly what `placeBid` allows.
- `viewer.ts`: `resolveViewer(slug, paddleParam)` says who is looking at a page. The session decides; outside production `?paddle=` overrides it and the fixture falls back to paddle 142 (`chooseViewer`).
- `request.ts` parses the guest pages' URL.
- "Available" bidding power here is the display rule (hold minus leading bids and won amounts). The engine enforces the stricter commitment rule.
