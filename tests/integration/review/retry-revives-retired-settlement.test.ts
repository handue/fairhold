/**
 * Review finding (wave 2): after Reset or the 6-hour cleanup retired a demo, an organizer's Retry still
 * reopens its settlement and the queue charges. retireDemo treats a finished settlement as over, and it
 * only waits for one that is running, because a void could race a capture. Retry brings that race back
 * once the event reads `settled`, so the guest can be charged for a gala that was ended. Until the fix,
 * this fails.
 */
import { describe, expect, it } from "vitest";

import { retireDemo } from "@/server/director/retire";
import { processSettlementQueue, retrySettlementItem, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { paypalError } from "../../unit/paypal/fake-paypal";
import { dependenciesFor, eventRow, itemOf, paypalWorld, runGala } from "../settlement/support";

const { pool, db } = getTestDatabase();

describe("Retry on a retired demo", () => {
  it("charges nothing", async () => {
    const world = paypalWorld();
    const deps = dependenciesFor(pool, db, world.payments);
    const gala = await runGala(pool, world, {
      isDemo: true,
      real: [{ number: 142, holdCents: 50_000 }],
      wins: [{ number: 142, lot: 7, cents: 32_000 }],
    });
    const authorizationId = gala.holds.get(142)?.authorizationId ?? "";

    await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps);
    world.failNext("capture", authorizationId, () => paypalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-declined"));
    await processSettlementQueue(deps);
    const failed = await itemOf(pool, gala.eventId, 142);
    expect(failed.status).toBe("failed");

    // Reset: the demo is retired. Its void has not gone through yet, and the sweep will retry it.
    expect(await retireDemo(pool, gala.eventId)).toBe("retired");
    expect(await eventRow(pool, gala.eventId)).toMatchObject({ status: "settled" });

    await retrySettlementItem(gala.eventId, failed.id, deps);
    await processSettlementQueue(deps);

    expect(world.captures).toHaveLength(0);
  });
});
