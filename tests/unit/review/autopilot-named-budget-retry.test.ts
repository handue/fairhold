/**
 * Review finding (Nov 7, autopilot): the mandate's budget B comes from the first plan budget parsed
 * in a turn (GlimProposalRecord.namedBudgetCents, src/server/glim/turn.ts), and a change card with
 * a null named budget keeps the running mandate's B (mergeMandateOnChange). When the model's first
 * propose_change omits the budget the guest just named and is sent back for another reason, the
 * retry carries the budget and the card shows it, but namedBudgetCents stays null. Confirming the
 * card then keeps the older, higher B, so autopilot may commit more on the guest's lots than the
 * budget the guest named and saw on the card. The "first parse" rule exists so a clamp can never
 * lower B; here it drops the guest's words instead.
 */
import { describe, expect, it } from "vitest";

import { mandateFromConfirmedCard } from "@/server/glim/mandate";
import { runGlimTurn } from "@/server/glim/turn";

import { goldenMandate } from "../../fixtures/glim/autopilot-golden";
import { createGoldenState } from "../../fixtures/glim/golden-state";
import { modelReply, scriptedModel, toolUseBlock } from "../glim/helpers";

const GUEST_TEXT = "Lower my budget to $150 and only keep the spa.";

describe("a budget the guest names on a change card (review)", () => {
  it("becomes the mandate's budget even when the model's first call left it out", async () => {
    const state = createGoldenState();
    state.plan = {
      id: "00000000-0000-4000-8000-00000000f001",
      status: "active",
      budgetCents: 50_000,
      items: [
        { lotNumber: 7, priority: 1, maxCents: 38_000, status: "winning" },
        { lotNumber: 12, priority: 2, maxCents: 12_000, status: "watching" },
      ],
    };
    let call = 0;
    const { model } = scriptedModel(() =>
      modelReply([
        toolUseBlock(
          "propose_change",
          call++ === 0
            ? // First try: the budget is left out and an unknown lot sends the proposal back.
              { budget_dollars: null, items: [{ lot_number: 12, priority: 1, cap_dollars: null }, { lot_number: 99, priority: 2, cap_dollars: null }], backup_lot_numbers: [], excluded_lot_numbers: [] }
            : { budget_dollars: 150, items: [{ lot_number: 12, priority: 1, cap_dollars: null }], backup_lot_numbers: [], excluded_lot_numbers: [] },
        ),
      ]),
    );

    const outcome = await runGlimTurn({
      state,
      transcript: [],
      guestText: GUEST_TEXT,
      usageSoFar: { paddleMessages: 0, eventMessages: 0, tokensToday: 0 },
      dailyTokenBudget: 1_000_000,
      model,
    });
    if (outcome.card?.type !== "plan") throw new Error(`expected a plan card, got ${outcome.error ?? outcome.reply}`);
    // The card the guest confirms says $150.
    expect(outcome.card).toMatchObject({ tool: "propose_change", budgetCents: 15_000 });

    const mandate = mandateFromConfirmedCard({
      card: outcome.card,
      guestWords: [GUEST_TEXT],
      confirmedAt: new Date("2026-11-08T05:12:00Z"),
      previous: goldenMandate(),
    });
    expect(mandate.budgetCents).toBe(15_000);
  });
});
