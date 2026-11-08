/** A NUL in an address is text Postgres refuses, so every read by slug has to treat it as no such event. */
import { describe, expect, it } from "vitest";

import { createPostgresGuestSource } from "@/server/queries/postgres-source";
import { getLedgerView } from "@/server/settlement/ledger";

import { getTestDatabase } from "../../helpers/database";

const { pool, db } = getTestDatabase();

describe("a slug holding a NUL", () => {
  it("is no event to the guest pages", async () => {
    const source = createPostgresGuestSource(db);
    await expect(source.findEvent("\u0000")).resolves.toBeNull();
    await expect(source.streamPosition?.("\u0000")).resolves.toBe("0");
  });

  it("is no event to the control room", async () => {
    await expect(getLedgerView("\u0000", pool)).resolves.toBeNull();
  });
});
