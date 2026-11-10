/**
 * After the organizer's charge the hold that was the bidding power is captured, so no authorized
 * hold is left. The guest pages' nav must still know what was held (to read "Paid $470 · Released
 * $30", as 11 does), instead of falling back to "Not set". Found on the hosted run of Nov 10.
 */
import { describe, expect, it } from "vitest";

import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { getCatalogView } from "@/server/queries/catalog";
import { processSettlementQueue, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";

const { pool } = getTestDatabase();

describe("the guest nav once bidding has closed", () => {
  it("keeps what was held through the charge, with what was won", async () => {
    const fixture = await createFixtureEvent({ moment: "closed" }, pool);

    const before = await getCatalogView({ slug: FIXTURE_SLUG, paddleNumber: 142, category: null });
    expect(before?.viewer).toMatchObject({ holdCents: 50_000, heldCents: 50_000, wonCents: 47_000 });

    await expect(startSettlement({ eventId: fixture.event.id, startedBySessionId: null })).resolves.toMatchObject({ kind: "started" });
    await processSettlementQueue();

    const after = await getCatalogView({ slug: FIXTURE_SLUG, paddleNumber: 142, category: null });
    expect(after?.event.status).toBe("settled");
    expect(after?.viewer).toMatchObject({ holdCents: null, heldCents: 50_000, wonCents: 47_000 });
  });

});
