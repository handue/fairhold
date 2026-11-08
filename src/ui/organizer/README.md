Screen 12, the control room, from `mockups/12-web-control-room.html`. The server side is `src/server/settlement`.

- `ControlRoomScreen`: the page's state. It starts from the server's `LedgerView`, reads it again on every stream row and on a slow poll, and posts the checks, the charge and the retries.
- `LedgerGrid`: AG Grid Community on `themeQuartz.withParams`, with `ledger.css` for what the Theming API has no param for. Loaded with `next/dynamic` and `ssr: false`. Updates go in as `applyTransactionAsync` by row id, so only changed cells flash.
- `LedgerRail`, `OrganizerNav`: the rail and the nav, value for value from the mockup.
- `ledger-model.ts`: every sentence and rule, with no React or grid, so it is tested on its own.

**What is approved.** Only "Ready to charge", on the seeded fixture (`npm run db:seed -- --moment=closed --date=2026-11-07`). It matches the approved PNG to 0.006% of pixels at a threshold of 48/255, all of them the mockup's window corners. Everything else is plain copy on the same layout until Sheet C's `design/24` and `design/27` are approved: bidding open, a failed check, charging, charged, a failed row, the Status column that replaces Glim and Held once charging starts, the simulated-guests line in a demo, and the nav's plain "Lots" and "Bidders".
