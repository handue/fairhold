/**
 * Review finding (wave 2): the "Glim stayed within the hold" check reads the hold as it is now, with a
 * missing hold counted as $0, and every problem it finds blocks. A guest who lost everything and whose
 * authorization PayPal voided (say they canceled the approval in their PayPal account) therefore fails
 * the check for good. No winner can ever be charged, though day2.md decision 41 says only a winner's
 * invalid hold counts. Until the fix, this fails.
 */
import { describe, expect, it } from "vitest";

import { closeEvent, createLimits, placeBid } from "@/server/engine";
import { createPostgresHoldStore } from "@/server/paypal/hold-store";
import { createPostgresWebhookEventStore } from "@/server/paypal/webhook-event-store";
import { processWebhookEvents, runSettlementChecks, startSettlement } from "@/server/settlement";

import { getTestDatabase } from "../../helpers/database";
import { createLot } from "../engine/support/fixtures";
import { dependenciesFor, holdRow, paypalWorld, runGala } from "../settlement/support";

const { pool, db } = getTestDatabase();

describe("a guest who won nothing and whose hold PayPal voided", () => {
  it("does not stop the winners being charged", async () => {
    const world = paypalWorld();
    const deps = dependenciesFor(pool, db, world.payments);
    const gala = await runGala(pool, world, {
      live: true,
      real: [
        { number: 142, holdCents: 50_000 },
        { number: 143, holdCents: 30_000 },
      ],
    });
    const winner = gala.paddles.get(142) ?? "";
    const loser = gala.paddles.get(143) ?? "";
    const lot = await createLot(pool, gala.eventId, { number: 7, startingBidCents: 10_000, minRaiseCents: 1_000 });

    // Glim bids for the loser, within their limit and hold; then the winner passes that limit.
    expect(await createLimits(loser, [{ lotId: lot, maxCents: 12_000 }], { owner: "glim", pool })).toMatchObject({ ok: true });
    expect(await placeBid(winner, lot, 20_000, "guest", { pool })).toMatchObject({ ok: true });

    const loserHold = gala.holds.get(143);
    await createPostgresWebhookEventStore(db).insertOnce({
      eventId: "WH-LOSER-VOIDED",
      eventType: "PAYMENT.AUTHORIZATION.VOIDED",
      resourceType: "authorization",
      resourceId: loserHold?.authorizationId ?? null,
      payload: {
        id: "WH-LOSER-VOIDED",
        event_type: "PAYMENT.AUTHORIZATION.VOIDED",
        resource: { id: loserHold?.authorizationId, status: "VOIDED" },
      },
    });
    await processWebhookEvents({}, { ...deps, holds: createPostgresHoldStore(db) });
    await expect(holdRow(pool, loserHold?.holdId ?? "")).resolves.toMatchObject({ status: "voided" });

    await closeEvent(gala.eventId, { pool });

    const checks = await runSettlementChecks(gala.eventId, deps);
    expect(checks.checks.find((check) => check.key === "glim_within_limits")).toMatchObject({ passed: true });
    expect(await startSettlement({ eventId: gala.eventId, startedBySessionId: null }, deps)).toMatchObject({ kind: "started" });
  });
});
