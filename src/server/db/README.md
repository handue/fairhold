Owner area: data model. The Drizzle schema, migrations (drizzle/), the Postgres pool and the dedicated LISTEN connection.

- `schema.ts` is the whole data model from `docs/planning/scope-map.json`, plus the two PayPal authorization ids, `bids.limit_id`, the limit lifecycle columns, `glim_transcript`, `director_jobs` and `error_log`. Every table hangs off `events` with on delete cascade, so deleting a demo gala deletes everything in it.
- Changing it: edit `schema.ts`, run `npm run db:generate -- --name <what_changed>`, review the SQL it writes into `drizzle/`, then `npm run db:migrate`. Never edit a migration that has been applied anywhere; add a new one.
- Areas read and write with SQL over these column names (the engine's and the seed's batches generate their uuids in code). Each area keeps its own string unions for statuses; `tests/unit/db/schema-contract.test.ts` checks them against the enums here.
- `client.ts`: one pool per process (`getPool()`, `getDb()`), and `openListenConnection()` for LISTEN, which the caller owns.
- `transaction.ts`: `withTransaction(pool, work)`, a plain transaction on a pooled client, and the `Queryable` type (a pool, or a client inside a transaction).
- `migrate.ts`: `runMigrations()`, used by `npm run db:migrate` (Render's pre-deploy command) and by the integration tests, which migrate one template database per run and copy it for each test file.
