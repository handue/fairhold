Screens 12, the control room, and 28, Insights. The server side is `src/server/settlement` (`ledger.ts` for 12, `insights.ts` for 28).

**12, the control room** (`mockups/12-web-control-room.html`, with every state of `design/24-control-room-states.html`):

- `ControlRoomScreen`: the page's state. It starts from the server's `LedgerView`, reads it again on every stream row and on a slow poll, and posts the checks, the charge, the retries and, in a demo, Close bidding now. It keeps the ledger as tall as the rail when the rail holds more than 12's (21's V6 row, a failed check), through `--ledger-body-min`.
- `checks-request.ts`: asking PayPal before charging, as a reducer. Only the latest request's answer counts, every answer is dispatched whatever became of the effect that sent it, a failure says "Not checked yet" with Check again, and a request gives up after 45 s. The rail can no longer be left on "Checking…".
- `LedgerGrid`: AG Grid Community on `themeQuartz.withParams`, with `ledger.css` for what the Theming API has no param for. Loaded with `next/dynamic` and `ssr: false`. Updates go in as `applyTransactionAsync` by row id, so only changed cells flash lime. The Status cell draws 24's marks: Simulated, Queued, Charging…, Charged, Released, and the Failed or Waiting pill with Retry or Ask again.
- `LedgerRail`, `OrganizerNav`: the rail, value for value from 12 and 24; the nav belongs to the entry track.
- `ledger-model.ts`: every sentence and rule, with no React or grid, so it is tested on its own.

**28, Insights** (`design/28-insights.html`), at `/e/<slug>/organizer/insights`, organizer only:

- `InsightsScreen`: the report's widgets on a twelve-track grid, re-read from the server on every stream row. The line chart, the sparkline and the two custom widgets are plain SVG and divs in the theme's colors, because AG Charts and AG Studio are not installed.
- `TopLotsGrid`: AG Grid Community. Its page is the top five by whatever column it is sorted on, every column has a filter behind a header button that shows on hover, and the CSV carries every row and column. Row grouping is Enterprise, so it is not used.
- `insights-model.ts`: the copy and the charts' geometry, tested on the board's own points.

**What differs from the boards, on purpose.** Before the charge, Hold utilization says "will be charged" and "will use", and while bidding runs "is bid now"; the board's past tense shows once charged. 28 also has 12's "Download CSV" on its event line, for the grid. A waiting row's Status column is 176px instead of 150, so "Waiting" and "Ask again" fit.
