import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/server/db/client";

import { getTestDatabase } from "../helpers/database";

describe("integration test database", () => {
  it("gives this file its own database", async () => {
    const { db, name } = getTestDatabase();
    const result = await db.execute<{ name: string }>(sql`select current_database() as name`);
    expect(result.rows[0]?.name).toBe(name);
    expect(name).toMatch(/^fh_test_\d+_/);
  });

  it("points the app's own client at the same database", async () => {
    const result = await getDb().execute<{ name: string }>(sql`select current_database() as name`);
    expect(result.rows[0]?.name).toBe(getTestDatabase().name);
  });
});
