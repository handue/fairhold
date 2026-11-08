import { APIUserAbortError, InternalServerError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { decideAutopilot } from "@/server/glim/autopilot/decide";
import { AUTOPILOT_USER_TEXT } from "@/server/glim/autopilot/prompt";
import type { AutopilotContext } from "@/server/glim/autopilot/types";
import { checkAutopilotModel, type AutopilotCapCheck } from "@/server/glim/caps";
import type { GlimModel } from "@/server/glim/client";
import { createRecordedGlimModel } from "@/server/glim/recorded";

import {
  createGoldenAutopilotContext,
  createRaiseContext,
  LOT,
  lotIn,
} from "../../../fixtures/glim/autopilot-golden";
import { modelReply, scriptedModel, textBlock } from "../helpers";

const WHY = "The dinner is past your budget now, so your money goes to the wine tasting you hearted.";
const golden = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: "change",
    lots: [
      { lot_number: 12, priority: 2, max_dollars: null },
      { lot_number: 9, priority: 3, max_dollars: null },
    ],
    raise_to_dollars: null,
    reason: "top_lot_out_of_reach",
    why: WHY,
    ...patch,
  });
const ALLOWED: AutopilotCapCheck = { ok: true };

function decide(context: AutopilotContext, model: GlimModel, extra: { modelAllowed?: AutopilotCapCheck; timeoutMs?: number } = {}) {
  return decideAutopilot({ context, model, modelAllowed: extra.modelAllowed ?? ALLOWED, timeoutMs: extra.timeoutMs });
}

const wineMax = (result: Awaited<ReturnType<typeof decideAutopilot>>) =>
  result.change?.change.after.find((entry) => entry.lotId === LOT.wine)?.maxCents;

/** A model that fails the test if it is called. */
const forbidden = scriptedModel(() => {
  throw new Error("the model must not be called");
});

describe("decideAutopilot", () => {
  it("applies a valid model decision, with its filtered why", async () => {
    const { model, requests } = scriptedModel(() => modelReply([textBlock(golden())]));
    const result = await decide(createGoldenAutopilotContext(), model);
    expect(result).toMatchObject({ outcome: "change", decidedBy: "model", reason: "top_lot_out_of_reach", modelWhy: WHY, adjusted: false });
    expect(wineMax(result)).toBe(38_000);
    expect(result.fixtureKey).toBe("autopilot:limit_exhausted:7:9");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ profile: "autopilot", fixtureKey: "autopilot:limit_exhausted:7:9", guestText: AUTOPILOT_USER_TEXT });
    expect(requests[0]?.messages.map((message) => message.role)).toEqual(["user", "system"]);
    expect(String(requests[0]?.messages[1]?.content)).toContain("AUTOPILOT REVIEW");
  });

  it("falls back to the rule on a refusal, max_tokens, an API error, non-JSON or an invalid decision", async () => {
    const replies: (() => ReturnType<typeof modelReply> | Promise<never>)[] = [
      () => modelReply([], "refusal"),
      () => modelReply([textBlock('{"action":"change"')], "max_tokens"),
      () => Promise.reject(new InternalServerError(500, undefined, "boom", new Headers())),
      () => modelReply([textBlock("Move the money to the wine tasting.")]),
      () => modelReply([textBlock(JSON.stringify({ action: "change", lots: [] }))]),
    ];
    for (const reply of replies) {
      const { model } = scriptedModel(reply);
      const result = await decide(createGoldenAutopilotContext(), model);
      expect(result).toMatchObject({ outcome: "change", decidedBy: "rule", modelWhy: null });
      expect(result.error).not.toBeNull();
      expect(wineMax(result)).toBe(38_000);
    }
  });

  it("aborts a slow model call and lets the rule decide", async () => {
    const slow: GlimModel = {
      mode: "live",
      respond: (_request, hooks = {}) =>
        new Promise((_resolve, reject) => hooks.signal?.addEventListener("abort", () => reject(new APIUserAbortError()))),
    };
    const result = await decide(createGoldenAutopilotContext(), slow, { timeoutMs: 20 });
    expect(result).toMatchObject({ outcome: "change", decidedBy: "rule", error: expect.stringContaining("aborted") });
  });

  it("logs a decision that breaks a mandate rule as rejected, and the rule decides", async () => {
    const { model } = scriptedModel(() => modelReply([textBlock(golden({ lots: [{ lot_number: 3, priority: 1, max_dollars: null }] }))]));
    const result = await decide(createGoldenAutopilotContext(), model);
    expect(result).toMatchObject({ outcome: "change", decidedBy: "rule", error: "decision_rejected" });
    expect(result.rejections.map((record) => [record.kind, record.rejectReason, record.decision])).toEqual([
      ["proposal_rejected", "outside_mandate", "rejected"],
    ]);
    expect(result.modelDecision?.lots).toEqual([{ lotNumber: 3, priority: 1, maxCents: null }]);
  });

  it("shows the template, not the model's why, when code adjusted its decision", async () => {
    const { model } = scriptedModel(() =>
      modelReply([textBlock(golden({ lots: [{ lot_number: 12, priority: 2, max_dollars: 150 }, { lot_number: 9, priority: 3, max_dollars: null }] }))]),
    );
    const result = await decide(createGoldenAutopilotContext(), model);
    expect(result).toMatchObject({ outcome: "change", decidedBy: "model", adjusted: true, modelWhy: null });
    expect(result.rejections.map((record) => record.rejectReason)).toEqual(["above_guest_cap"]);
  });

  it("keeps when the model keeps", async () => {
    const { model } = scriptedModel(() => modelReply([textBlock(golden({ action: "keep", lots: [], reason: "no_change" }))]));
    expect(await decide(createGoldenAutopilotContext(), model)).toMatchObject({ outcome: "keep", decidedBy: "model" });
  });

  it("prepares the raise the model asks for, within the range code allows", async () => {
    const { model } = scriptedModel(() =>
      modelReply([
        textBlock(
          JSON.stringify({
            action: "prepare_raise",
            lots: [
              { lot_number: 7, priority: 1, max_dollars: null },
              { lot_number: 12, priority: 2, max_dollars: null },
            ],
            raise_to_dollars: 600,
            reason: "raise_needed",
            why: "The dinner matters most to you, so I am asking for a little more room.",
          }),
        ),
      ]),
    );
    const result = await decide(createRaiseContext(), model);
    expect(result).toMatchObject({ outcome: "prepare_raise", decidedBy: "model" });
    expect(result.raise).toMatchObject({ amountCents: 60_000, lotId: LOT.chef, lotNumber: 7, bounds: { minCents: 54_000, maxCents: 80_000 } });
  });

  it("never calls the model when nothing fits", async () => {
    const context = createGoldenAutopilotContext();
    lotIn(context, 9).nextMinimumCents = 40_000;
    expect(await decide(context, forbidden.model)).toMatchObject({ outcome: "skipped", decidedBy: "none", brief: null });
    expect(forbidden.requests).toHaveLength(0);
  });

  it("lets the rule decide, without a model call, at the caps, within 10 s of the last call or under 25 s to the close", async () => {
    const now = createGoldenAutopilotContext().state.now;
    const usage = { paddleModelDecisions: 0, eventModelDecisions: 0, lastModelCallAt: null, tokensToday: 0 };
    const capped = [
      checkAutopilotModel({ ...usage, paddleModelDecisions: 12 }, 1_000_000, now),
      checkAutopilotModel({ ...usage, eventModelDecisions: 150 }, 1_000_000, now),
      checkAutopilotModel({ ...usage, lastModelCallAt: new Date(now.getTime() - 9_000) }, 1_000_000, now),
      checkAutopilotModel({ ...usage, tokensToday: 600_000 }, 1_000_000, now),
    ];
    expect(capped.map((check) => (check.ok ? "ok" : check.reason))).toEqual(["paddle_decisions", "event_decisions", "model_gap", "daily_tokens"]);
    expect(checkAutopilotModel({ ...usage, lastModelCallAt: new Date(now.getTime() - 10_000), tokensToday: 599_999 }, 1_000_000, now)).toEqual({ ok: true });
    for (const modelAllowed of capped) {
      const result = await decide(createGoldenAutopilotContext(), forbidden.model, { modelAllowed });
      expect(result).toMatchObject({ outcome: "change", decidedBy: "rule", ruleBecause: modelAllowed.ok ? null : modelAllowed.reason });
    }
    const closing = createGoldenAutopilotContext();
    lotIn(closing, 7).closesAt = new Date(closing.state.now.getTime() + 20_000);
    expect(await decide(closing, forbidden.model)).toMatchObject({ decidedBy: "rule", ruleBecause: "closing_lot" });
    expect(forbidden.requests).toHaveLength(0);
  });

  it("applies an approved raise's plan with no model call", async () => {
    const context = createRaiseContext();
    context.state.holdCents = 60_000;
    context.triggers = [{ kind: "hold_raised", eventLogId: "2001", holdId: "hold-2", amountCents: 60_000 }];
    context.pendingRaise = {
      actionId: "raise-1",
      amountCents: 60_000,
      createdAt: context.state.now,
      approved: true,
      lots: [
        { lotNumber: 7, priority: 1, maxCents: null },
        { lotNumber: 12, priority: 2, maxCents: null },
      ],
    };
    const result = await decide(context, forbidden.model);
    expect(result).toMatchObject({ outcome: "change", decidedBy: "pending_raise", reason: "raise_needed" });
    expect(result.change?.change.after.map((entry) => [entry.lotNumber, entry.maxCents])).toEqual([
      [7, 48_000],
      [12, 12_000],
    ]);
    expect(forbidden.requests).toHaveLength(0);
  });

  it("matches a recorded decision by its fixture key, and lets the rule decide without one", async () => {
    const recorded = createRecordedGlimModel({
      recordings: [
        {
          name: "golden",
          fixtureKey: "autopilot:limit_exhausted:7:9",
          responses: [{ content: [{ type: "text", text: golden() }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } }],
        },
      ],
    });
    expect(await decide(createGoldenAutopilotContext(), recorded)).toMatchObject({ decidedBy: "model", modelWhy: WHY, model: "recorded" });
    const other = createGoldenAutopilotContext();
    other.triggers = [{ kind: "lot_lost", eventLogId: "9", lotId: LOT.chef, lotNumber: 7, winningCents: 40_000 }];
    expect(await decide(other, recorded)).toMatchObject({ decidedBy: "rule", outcome: "change" });
  });
});
