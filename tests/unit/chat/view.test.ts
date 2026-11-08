/** The panel's status line and quick replies, from Glim's state. */
import { describe, expect, it } from "vitest";

import { PLAN_CARDS_ARM_AUTOPILOT, planCardsArmAutopilot } from "@/server/chat/switch";
import { biddingPowerHref, chatQuickReplies, chatStatus } from "@/server/chat/view";
import type { GlimPlanState, GlimState } from "@/server/glim/types";
import { parsePowerAmount } from "@/ui/power/power-href";

import { createGoldenState } from "../../fixtures/glim/golden-state";

const SLUG = "gala-1";

const plan = (status: GlimPlanState["status"]): GlimPlanState => ({
  id: "plan-1",
  status,
  budgetCents: 50_000,
  items: [
    { lotNumber: 7, priority: 1, maxCents: 38_000, status: "watching" },
    { lotNumber: 12, priority: 2, maxCents: 12_000, status: "watching" },
  ],
});

const replies = (state: GlimState, eventLive = true) => chatQuickReplies({ state, eventLive, slug: SLUG });
const labels = (state: GlimState, eventLive = true) => replies(state, eventLive).map((reply) => reply.label);

describe("quick replies", () => {
  it("are 07's three with a plan running", () => {
    const state = { ...createGoldenState(), plan: plan("active") };
    expect(replies(state)).toEqual([
      { kind: "link", label: "Raise my budget", href: `/e/${SLUG}/power` },
      { kind: "skip", label: "Skip the spa", lotNumber: 12 },
      { kind: "ask", label: "How am I doing?", text: "How am I doing?" },
    ]);
  });

  it("offer to skip the last lot still running, by its own name", () => {
    const base = plan("active");
    const state = {
      ...createGoldenState(),
      plan: { ...base, items: base.items.map((item) => (item.lotNumber === 12 ? { ...item, status: "skipped" as const } : item)) },
    };
    expect(labels(state)).toEqual(["Raise my budget", "Skip Chef's Table", "How am I doing?"]);
  });

  it("offer no skip with nothing to stop", () => {
    expect(labels({ ...createGoldenState(), plan: null })).toEqual(["Raise my budget", "How am I doing?"]);
    expect(labels({ ...createGoldenState(), plan: plan("proposed") })).toEqual(["Raise my budget", "How am I doing?"]);
  });

  it("offer Resume on a paused plan", () => {
    expect(labels({ ...createGoldenState(), plan: plan("paused") })).toEqual(["Resume Glim", "Raise my budget", "How am I doing?"]);
  });

  it("stop offering a raise at the event's maximum", () => {
    const state = createGoldenState();
    expect(labels({ ...state, holdCents: state.event.holdMaxCents })).toEqual(["How am I doing?"]);
  });

  it("send a guest with no bidding power to set it", () => {
    expect(replies({ ...createGoldenState(), holdCents: null })).toEqual([
      { kind: "link", label: "Set your bidding power", href: `/e/${SLUG}/power` },
    ]);
  });

  it("are only the question once bidding is over", () => {
    expect(labels({ ...createGoldenState(), plan: plan("active") }, false)).toEqual(["How am I doing?"]);
  });
});

describe("the header's status", () => {
  const status = (state: GlimState, eventStatus: Parameters<typeof chatStatus>[0]["eventStatus"] = "live") =>
    chatStatus({ state, eventStatus, closedAt: new Date("2026-11-08T05:30:00Z"), closesAt: new Date("2026-11-08T05:30:00Z") });

  it("reads 07's approved line with a hold", () => {
    expect(status(createGoldenState())).toEqual({ tone: "on", text: "On duty · $500 held with PayPal" });
  });

  it("says when bidding power isn't set", () => {
    expect(status({ ...createGoldenState(), holdCents: null })).toEqual({ tone: "off", text: "Bidding power not set" });
  });

  it("says when Glim is paused", () => {
    expect(status({ ...createGoldenState(), plan: plan("paused") })).toEqual({ tone: "off", text: "Paused · $500 held with PayPal" });
  });

  it("is off duty once bidding closed, in 11's words", () => {
    expect(status(createGoldenState(), "closed")).toEqual({ tone: "off", text: "Off duty since 9:30 PM" });
    expect(status(createGoldenState(), "settled").text).toBe("Off duty since 9:30 PM");
    expect(status(createGoldenState(), "scheduled").text).toBe("Off duty");
  });
});

describe("09's link", () => {
  it("names the amount in whole dollars when Glim suggested one", () => {
    expect(biddingPowerHref("riverside gala", 100_000)).toBe("/e/riverside%20gala/power?amount=1000");
    expect(biddingPowerHref(SLUG)).toBe(`/e/${SLUG}/power`);
  });

  it("is what 09 reads", () => {
    const query = new URL(biddingPowerHref(SLUG, 100_000), "https://fairhold.example").searchParams;
    expect(parsePowerAmount(Object.fromEntries(query))).toBe(100_000);
  });
});

describe("the autopilot's switch", () => {
  it("is off until the user approves V1 (design/21)", () => {
    expect(PLAN_CARDS_ARM_AUTOPILOT).toBe(false);
    expect(planCardsArmAutopilot()).toBe(false);
  });
});
