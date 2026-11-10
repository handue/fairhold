/**
 * The raise Glim prepares (V3) is for one plan. It is stored with that plan's id, and its card says
 * why: "to stay in for the chef's dinner". Once the guest edits the plan and drops Chef's Table, the
 * old offer has to end: no "Approve $540 in PayPal" card, no PayPal window from the raise route, and
 * no pending raise for the autopilot. Found by the Day 3 review, when loadOpenRaiseOffer
 * (src/server/plans/raise-offer.ts) only asked that *a* plan with a mandate was running.
 */
import { describe, expect, it } from "vitest";

import { POST as postRaise } from "@/app/api/glim/[slug]/raises/[actionId]/route";
import { syncEventCards } from "@/server/chat/event-card-sync";
import type { AutopilotRaiseCardView, ChatView } from "@/server/chat/types";
import { loadAutopilotRead } from "@/server/plans/context";
import { loadOpenRaiseOffer } from "@/server/plans/raise-offer";
import { runAutopilot } from "@/server/plans/run";
import { claimDue, scanFacts } from "@/server/plans/scan";

import { getTestDatabase } from "../../helpers/database";
import { goldenProposal, modelReply, scriptedModel, toolUseBlock } from "../../unit/glim/helpers";
import { clickEdit, clickStartBidding, createChatGala, lastPlanCard, readView } from "../chat/support";
import { bid, makeDue, recordedModel, rows, startBidding } from "../plans/support";

const database = getTestDatabase();
const { pool } = database;
const ORIGIN = "https://fairhold.example";

async function runDue(paddleId: string) {
  await syncEventCards({ paddleId, pool });
  await scanFacts(pool);
  await makeDue(pool, paddleId);
  const [claim] = await claimDue(pool, { limit: 4 });
  if (!claim) throw new Error("nothing was due");
  return runAutopilot(claim, { database, model: recordedModel });
}

const raiseCard = (view: ChatView) =>
  [...view.messages].reverse().find((message) => message.card?.type === "autopilot_raise")?.card as AutopilotRaiseCardView | undefined;

describe("Glim's prepared raise after the guest edits the plan", () => {
  it("ends once the plan it was for is replaced by one without its lot", async () => {
    // "$800. I really want the chef's dinner. Spa only under $120.", then the rival's $360 and $400.
    const gala = await createChatGala(pool);
    let call = 0;
    const chat = scriptedModel(() => modelReply([toolUseBlock("propose_plan", goldenProposal(call++ === 0 ? 800 : 500))]));
    await startBidding(database, gala.jamie, { guestText: "$800. I really want the chef's dinner. Spa only under $120.", model: chat.model });
    await bid(pool, gala.rival, gala.lots.chef, 36_000);
    await bid(pool, gala.rival, gala.lots.chef, 40_000);
    const report = await runDue(gala.jamie);
    expect(report.outcome).toBe("raise_prepared");
    const [offer] = await rows<{ id: string; amount_cents: number; plan_id: string }>(pool, "select id, amount_cents, plan_id from glim_actions where id = $1", [
      report.actionId,
    ]);
    if (!offer) throw new Error("no prepared raise");
    expect(raiseCard(await readView(gala))).toMatchObject({ actionId: offer.id, ended: false });

    // The guest opens Edit and takes Chef's Table out: only Spa Day stays, then Update plan.
    const running = lastPlanCard(await readView(gala));
    expect(running.planId).toBe(offer.plan_id);
    const edited = await clickEdit(gala, running.planId, [{ lotNumber: 12, maxCents: 12_000 }]);
    const change = lastPlanCard(edited.view);
    expect(change.items.map((item) => item.lotNumber)).toEqual([12]);
    expect((await clickStartBidding(gala, change.planId)).status).toBe(200);
    expect(await rows(pool, "select status from glim_plans where id = $1", [offer.plan_id])).toEqual([{ status: "superseded" }]);

    // Fails today: the offer for the superseded plan is still open, its card still offers Approve,
    // the autopilot still holds it as pending, and the route opens a $540 PayPal window.
    expect.soft(await loadOpenRaiseOffer(pool, gala.jamie)).toBeNull();
    expect.soft(raiseCard(await readView(gala))?.ended).toBe(true);
    expect.soft((await loadAutopilotRead(gala.jamie, [], database))?.context?.pendingRaise ?? null).toBeNull();
    const approve = await postRaise(
      new Request(`${ORIGIN}/api/glim/${gala.slug}/raises/${offer.id}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, cookie: gala.cookie },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ slug: gala.slug, actionId: offer.id }) },
    );
    expect.soft(approve.status).toBe(409);
  });
});
