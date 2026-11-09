/**
 * closing_soon (docs/planning/glim-autopilot.md §3.1): a plan lot where the guest leads at exactly
 * Glim's maximum, closing within 90 s, wakes Glim once. With a minute left the model decides (the
 * recorded reply lowers Spa Day so Chef's Table can go higher); under 25 s the rule decides, and
 * the rule never makes a priority call.
 */
import { describe, expect, it } from "vitest";

import { runAutopilot } from "@/server/plans/run";
import { claimDue, releaseClaim, scanClosingSoon, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";

import { bid, createGala, forbiddenModel, makeDue, recordedModel, rows, startBidding } from "./support";

const database = getTestDatabase();
const { pool } = database;

/** Jamie's plan confirmed, a rival's $360 answered at Glim's $380 maximum, Chef's Table closing soon. */
async function atLimitClosingIn(seconds: number) {
  const gala = await createGala(pool);
  await startBidding(database, gala.jamie);
  await bid(pool, gala.rival, gala.lots.chef, 36_000);
  // The facts so far (limit_set, limit_raised) never wake Glim; move the cursor past them.
  expect(await scanFacts(pool)).toMatchObject({ triggers: 0 });
  await pool.query("update lots set closes_at = now() + make_interval(secs => $2) where id = $1", [gala.lots.chef, seconds]);
  return gala;
}

describe("closing_soon", () => {
  it("wakes Glim once for a plan lot at its limit with a minute left, and the model may lower Spa Day for it", async () => {
    const gala = await atLimitClosingIn(60);
    expect(await scanClosingSoon(pool)).toBe(1);
    expect(await scanClosingSoon(pool)).toBe(0);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("closing_soon was not due at once");
    expect(claim.reasons).toEqual([expect.objectContaining({ kind: "closing_soon", lotId: gala.lots.chef, lotNumber: 7 })]);
    // Claimed, it is not queued again.
    expect(await scanClosingSoon(pool)).toBe(0);

    const report = await runAutopilot(claim, { database, model: recordedModel });
    expect(report).toMatchObject({ outcome: "applied", decidedBy: "model" });
    expect(report.decision?.fixtureKey).toBe("autopilot:closing_soon:7:7");
    expect(
      await rows(pool, "select lot_id, max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents", [gala.jamie]),
    ).toEqual([
      { lot_id: gala.lots.spa, max_cents: 9_000 },
      { lot_id: gala.lots.chef, max_cents: 41_000 },
    ]);
    const [message] = await rows<{ card: Record<string, unknown> }>(pool, "select card from chat_messages where id = $1", [report.chatMessageId]);
    expect(message?.card).toMatchObject({
      triggerLine: expect.stringMatching(/^(1 minute|Under a minute) left on Chef’s Table\.$/),
      whatLine: "I lowered Spa Day to $90 so Chef’s Table can go up to $410.",
    });
    // Reviewed once: never again for this lot.
    expect(await rows(pool, "select closing_reviewed from glim_autopilot where paddle_id = $1", [gala.jamie])).toEqual([
      { closing_reviewed: [gala.lots.chef] },
    ]);
    expect(await scanClosingSoon(pool)).toBe(0);
  });

  it("lets the rule decide under 25 s, and the rule never lowers a lot to make a priority call", async () => {
    await atLimitClosingIn(20);
    expect(await scanClosingSoon(pool)).toBe(1);
    const [claim] = await claimDue(pool, { limit: 4 });
    if (!claim) throw new Error("closing_soon was not due at once");
    const model = forbiddenModel();
    const report = await runAutopilot(claim, { database, model });
    expect(report).toMatchObject({ outcome: "kept", decidedBy: "rule" });
    expect(report.decision?.ruleBecause).toBe("closing_lot");
    expect(model.calls).toBe(0);
    const [run] = await rows<{ outcome: string; decided_by: string; error: string; model: string | null }>(
      pool,
      "select outcome, decided_by, error, model from glim_autopilot_runs where id = $1",
      [report.runId],
    );
    expect(run).toEqual({ outcome: "kept", decided_by: "rule", error: "rule: closing_lot", model: null });
  });

  it("does not wake Glim for a lot the guest leads below Glim's maximum", async () => {
    const gala = await createGala(pool);
    await startBidding(database, gala.jamie);
    await scanFacts(pool);
    // Jamie leads Chef's Table at her own $320, under Glim's $380: nothing to decide.
    await pool.query("update lots set closes_at = now() + interval '60 seconds' where id = $1", [gala.lots.chef]);
    expect(await scanClosingSoon(pool)).toBe(0);
    await makeDue(pool, gala.jamie);
    const claims = await claimDue(pool, { limit: 4 });
    for (const claim of claims) await releaseClaim(pool, claim);
    expect(claims).toEqual([]);
  });
});
