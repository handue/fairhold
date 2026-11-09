Owner area: live updates. Fan-out from the LISTEN connection to /api/stream server-sent events, with Last-Event-ID replay and heartbeats. The browser's end is `src/ui/live/`.

- `notify.ts`: `appendEventLog`, the one writer of event_log, inside the transaction that made the change.
- `types.ts`: the stream's contract, shared with the browser: `StreamEvent` (one frame per event_log row, named after its type), `StreamPayloads` (each type's payloads, from the engine's own payload types), the control frames, positions (`parseStreamPosition`, `isAfterPosition`) and `canSeeStreamRow` (who receives what). A new payload goes there first.
- `hub.ts`: `getStreamHub()`, one LISTEN connection per process, fanned out in memory. A NOTIFY only says something happened in an event; the hub reads the new rows once per event and hands each stream what its viewer may see. Its comment says how a stream joins with no gap and no duplicate. NOTIFY is the fast path: the tick reads every channel again each heartbeat, and a lost connection is reopened and caught up.
- `rows.ts`: the reads. `readVisibleRows` is `canSeeStreamRow` in SQL, and `tests/integration/sse/visibility.test.ts` holds the two together.
- `response.ts`: the `Response` for one stream, with the headers nothing may buffer or compress behind. A client that stops reading is dropped past 1 MiB and catches up by replay.
- `audience.ts`: who a request speaks for, by the pages' own rule (`chooseViewer`): the session in production, `?paddle=` too outside it.
- `client-streams.ts`: at most 20 open streams per client address per process. Past it the route answers 429 and the browser polls.
- `poll.ts`: the same rows as JSON for `GET /api/stream/poll`, the fallback.

Routes: `GET /api/stream?slug=<slug>` and `GET /api/stream/poll?slug=<slug>&after=<position>`. A browser's own retry sends `Last-Event-ID`; `?after=` does the same for a new connection; with neither, a stream starts `STREAM_RECENT_ROWS` behind the newest row, so a page that just rendered misses nothing while it hydrates. More than `STREAM_REPLAY_LIMIT` rows behind, it sends `resync` and goes on from there.

A row for the guest's eyes goes on the paddle's channel: rows stay in server memory until `canSeeStreamRow` lets one out.
