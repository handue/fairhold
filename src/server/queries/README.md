Owner area: read models. Server-side queries the pages and route handlers render (catalog, paddle overview, ledger, receipt, projector).

- `catalog.ts` (08) and `lot.ts` (05) build typed views (`types.ts`) from a `GuestReadSource`: the rows a page needs, nothing it does not.
- `postgres-source.ts` reads those rows in SQL over the scope map's column names (the names the seed writes), with ids as text, amounts as integers and times as epoch milliseconds.
- `source.ts` picks the source: Postgres, or outside production the UI fixture (`UI_FIXTURE=riverside`) and a frozen clock (`FREEZE_CLOCK_AT`) for visual checks.
- `glim-state.ts` builds Glim's `GlimState` for one paddle from the same reads plus the engine's `getBiddingPower` and `getCommitments`, so Glim plans within exactly what `placeBid` allows.
- `request.ts` parses the guest pages' URL; until the session cookie lands the viewer comes from `?paddle=` (default 142).
- "Available" bidding power here is the display rule (hold minus leading bids and won amounts). The engine enforces the stricter commitment rule.
