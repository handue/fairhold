Owner area: the browser's end of the live layer. The server's end is `src/server/sse/`.

`live-stream.ts` is the connection, with no React in it: EventSource, then polling after repeated failures, and back. `LiveStream.tsx` is the React side; the event layout puts one stream around every page (`src/ui/event/LiveProviders.tsx`), and reading any of these opens it:

```tsx
const records = useLiveRecords(seed);              // a page's rows, kept current (08 and 05)
useStreamEvent((row) => { ... });                  // run something on each new row
useLiveRefresh((row) => row.type === "hold");      // re-render the server's page on matching rows
<LiveRefresh types={["hold", "settlement"]} />     // the same, from a server component
const serverNow = useLiveServerNow(renderedAt);    // for ServerClockProvider
useLiveStream().pollNow();                         // after the guest's own action
```

Which to use:
- **A screen with a fold** (08, 05): the server reads its rows and a position (`getCatalogSeed`), and the client component runs the same view builder over `useLiveRecords(seed)`. No logic is written twice, and a price moves in under a second without a request.
- **Any other screen:** `useLiveRefresh` or `<LiveRefresh>`. The page re-renders on the server, which is always right, at the cost of one render per burst of rows (debounced by 300 ms). `resync` refreshes it too.
- **Something that is not a page** (a chat, a grid): `useStreamEvent`. It fires for new rows only, never for the history a first connection replays.

`useStreamEvent` and `useLiveRefresh` must stay cheap: they run for every row of the event a viewer may see. Narrow on `row.type`, then `row.payload.kind` (hold rows: `row.payload.status`); `src/server/sse/types.ts` has them all.
