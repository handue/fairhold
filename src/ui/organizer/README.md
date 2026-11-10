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

**Below 1440** (max-* variants only, so 1440 is as approved):

- 12: from 1280 the ledger stays beside the 416px rail, with 32px gutters. Below 1280 the rail comes first, as a two-column card (one column on a phone), and the ledger follows at the full width, so from 768 up every column shows without scrolling (beside a 360 rail at 1024 the Status column was cut off); below 1024 "Settlement ledger" takes its own line over the filter pills and the search. On a phone every action is full width and 48 tall, the pills are a segmented control and the search is 44 tall with 16px text, and Lots won keeps 152 (from 120) so most of a title shows before the frame scrolls. Below 1440 Bidder is 108 (from 100), so a name keeps its initial. Wherever the grid's columns don't fit (320 to 430) it scrolls sideways inside its frame with the Paddle column pinned, never the page; every column is drawn even off screen (`suppressColumnVirtualisation`).
- 28: the figures go 4 across, 2 by 2 below 1280, and one column on a phone. Below 1280 the chart and Top lots take the full width, with Limits kept and Hold utilization side by side between them. The line chart redraws at its widget's width (`raisedChart`'s width; the drawn 778 is kept within 4px of it, so 1440 is unchanged), its round times thinning on narrow screens. Below 1024 Top lots' number columns narrow (Estimated value's header on two lines) and Title gets their room; on a phone it scrolls inside its widget with Lot pinned.
- `OrganizerCorner`: fixed in the corner at 1440; below 1440 the orb and its bubble close the page, under the ledger, so they never cover the rail's action on a short laptop screen.

**What differs from the boards, on purpose.** Before the charge, Hold utilization says "will be charged" and "will use", and while bidding runs "is bid now"; the board's past tense shows once charged. 28 also has 12's "Download CSV" on its event line, for the grid. A waiting row's Status column is 176px instead of 150, so "Waiting" and "Ask again" fit.
