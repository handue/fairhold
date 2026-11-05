import { afterAll, inject } from "vitest";

import { closeDatabaseClient } from "@/server/db/client";

import { attachTestDatabase } from "./database";

// Runs before each integration test file is imported, so app code sees this file's database.
const testDatabase = await attachTestDatabase(inject("testDatabase"));

afterAll(async () => {
  await closeDatabaseClient();
  await testDatabase.dispose();
});
