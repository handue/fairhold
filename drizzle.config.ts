import { defineConfig } from "drizzle-kit";

import { loadLocalEnv } from "./scripts/lib/load-local-env";
import { getDatabaseUrl } from "./src/server/lib/env";

loadLocalEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: getDatabaseUrl() },
  strict: true,
  verbose: true,
});
