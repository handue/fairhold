import { existsSync } from "node:fs";
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import type { Database } from "./client";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

export type MigrationOutcome = "applied" | "no-migrations";

/**
 * Applies pending migrations from drizzle/. Until the first `npm run db:generate` there is no
 * journal, which drizzle treats as an error; here it is a no-op so deploys and tests still run.
 */
export async function runMigrations(
  db: Database,
  migrationsFolder: string = MIGRATIONS_FOLDER,
): Promise<MigrationOutcome> {
  if (!existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    return "no-migrations";
  }
  await migrate(db, { migrationsFolder });
  return "applied";
}
