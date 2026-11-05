/**
 * Applies pending Drizzle migrations to DATABASE_URL. Also Render's pre-deploy command, so it
 * depends on nothing but the database URL.
 */
import { createDatabaseClient } from "@/server/db/client";
import { runMigrations } from "@/server/db/migrate";
import { getDatabaseUrl } from "@/server/lib/env";

import { loadLocalEnv } from "./lib/load-local-env";

async function main(): Promise<void> {
  loadLocalEnv();
  const client = createDatabaseClient(getDatabaseUrl(), { maxConnections: 1 });
  try {
    const outcome = await runMigrations(client.db);
    console.log(
      outcome === "applied"
        ? "Migrations applied; the database is up to date."
        : "No migrations yet (drizzle/meta/_journal.json is missing); nothing to apply.",
    );
  } finally {
    await client.pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error);
  process.exitCode = 1;
});
