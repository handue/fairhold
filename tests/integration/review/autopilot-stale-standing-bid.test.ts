/**
 * Review finding (Nov 7, autopilot): "What is code. It is built from the engine's actual result,
 * never from the decision's intent" (docs/planning/glim-autopilot.md §6.2). When the main move of a
 * change is a drop, changeLines (src/server/glim/autopilot/copy.ts) looks for the lot in the
 * engine's result, but a drop goes through removeLimit (or createLimits' removeLotIds), whose lots
 * are never in AppliedFacts.lots. It then falls back to the run's first read, taken before the model
 * call, and the card and the action row state "Your $X bid stands" with that read's amount. A bid
 * placed while the model decided makes the card name the wrong figure. (skipLot reads the leading
 * bid under its lot lock and gets it right.)
 */
import { describe, expect, it } from "vitest";

import type { GlimModel } from "@/server/glim/client";
import { syntheticMessage } from "@/server/glim/recorded";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";
import { bid, createGala, heart, makeDue, rows, startBidding } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;

const DROP_EVERYTHING = JSON.stringify({
  action: "change",
  lots: [],
  raise_to_dollars: null,
  reason: "top_lot_out_of_reach",
  why: "The dinner got away, so I stopped bidding and kept the rest of your money free.",
});

describe("a dropped lot's card (review)", () => {
  it("names the bid that stands after the apply, not the one read before the model call", async () => {
    const gala = await createGala(pool);
    await heart(pool, gala.jamie, gala.lots.wine);
    await startBidding(database, gala.jamie);
    // Glim's $120 limit leads Spa Day at $90; a rival's $400 passes Glim's $380 on Chef's Table.
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    await scanFacts(pool);
    await makeDue(pool, gala.jamie);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("not due");

    const model: GlimModel = {
      mode: "live",
      async respond() {
        // While the model decides, a rival bids $95 on Spa Day and Glim's limit answers at $100.
        await bid(pool, gala.rival, gala.lots.spa, 9_500);
        return syntheticMessage([{ type: "text", text: DROP_EVERYTHING, citations: null }], "end_turn");
      },
    };
    const report = await runAutopilot(claim, { database, model });
    expect(report).toMatchObject({ outcome: "applied", decidedBy: "model" });
    expect(await rows(pool, "select current_bid_cents, high_paddle_id from lots where id = $1", [gala.lots.spa])).toEqual([
      { current_bid_cents: 10_000, high_paddle_id: gala.jamie },
    ]);

    const [message] = await rows<{ card: { whatLine: string } }>(pool, "select card from chat_messages where id = $1", [report.chatMessageId]);
    expect(message?.card.whatLine).toBe("I stopped bidding on Spa Day. Your $100 bid stands.");
  });
});
