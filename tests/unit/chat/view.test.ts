/** The panel's status line and quick replies, from Glim's state. */
import { describe, expect, it } from "vitest";

import { PLAN_CARDS_ARM_AUTOPILOT, planCardsArmAutopilot } from "@/server/chat/switch";
import { biddingPowerHref, chatQuickReplies, chatStatus, closingCard, type LastExchange } from "@/server/chat/view";
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

const replies = (state: GlimState, eventLive = true, last?: LastExchange) => chatQuickReplies({ state, eventLive, slug: SLUG, last });
const labels = (state: GlimState, eventLive = true, last?: LastExchange) => replies(state, eventLive, last).map((reply) => reply.label);

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

  it("are design/22 #1's three on first open, before any plan", () => {
    expect(replies({ ...createGoldenState(), plan: null })).toEqual([
      { kind: "ask", label: "All $500", text: "All $500" },
      { kind: "ask", label: "What closes next?", text: "What closes next?" },
      { kind: "ask", label: "What can you do?", text: "What can you do?" },
    ]);
    expect(labels({ ...createGoldenState(), plan: plan("proposed") })).toEqual(["All $500", "What closes next?", "What can you do?"]);
  });

  it("ask what else fits once the guest has talked with no plan running, or after a refusal (design/22 #5, #6)", () => {
    const talked = { talked: true, failedGuestText: null, refused: false };
    expect(labels({ ...createGoldenState(), plan: null }, true, talked)).toEqual(["What else fits?", "How am I doing?"]);
    const refused = { talked: true, failedGuestText: null, refused: true };
    expect(labels({ ...createGoldenState(), plan: plan("active") }, true, refused)).toEqual(["What else fits?", "How am I doing?"]);
  });

  it("offer Try again with the guest's own words after an error (design/22 #4)", () => {
    const failed = { talked: true, failedGuestText: "$500. I really want the chef’s dinner.", refused: false };
    expect(replies({ ...createGoldenState(), plan: plan("active") }, true, failed)).toEqual([
      { kind: "ask", label: "Try again", text: "$500. I really want the chef’s dinner." },
      { kind: "link", label: "See the lots", href: `/e/${SLUG}` },
    ]);
  });

  it("keep 07's three while paused, since Resume is in the header (design/22 #10)", () => {
    expect(labels({ ...createGoldenState(), plan: plan("paused") })).toEqual(["Raise my budget", "Skip the spa", "How am I doing?"]);
  });

  it("stop offering a raise at the event's maximum", () => {
    const state = createGoldenState();
    expect(labels({ ...state, holdCents: state.event.holdMaxCents, plan: plan("active") })).toEqual(["Skip the spa", "How am I doing?"]);
  });

  it("explain holds to a guest with no bidding power; the card under the greeting sends them to 09 (design/22 #2)", () => {
    expect(labels({ ...createGoldenState(), holdCents: null })).toEqual(["How does a hold work?", "What can you do?"]);
  });

  it("are none once bidding is over: the input closes (design/22 #12)", () => {
    expect(labels({ ...createGoldenState(), plan: plan("active") }, false)).toEqual([]);
  });
});

describe("the header's status (design/22 #23)", () => {
  const status = (state: GlimState, eventStatus: Parameters<typeof chatStatus>[0]["eventStatus"] = "live", extra: Partial<Parameters<typeof chatStatus>[0]> = {}) =>
    chatStatus({ state, eventStatus, closedAt: new Date("2026-11-08T05:30:00Z"), closesAt: new Date("2026-11-08T05:30:00Z"), ...extra });

  it("reads Not bidding yet, grey, until Start bidding", () => {
    expect(status(createGoldenState())).toEqual({ tone: "off", mark: "off", text: "Not bidding yet · $500 held with PayPal" });
    expect(status({ ...createGoldenState(), plan: plan("proposed") }).text).toBe("Not bidding yet · $500 held with PayPal");
  });

  it("reads 07's approved On duty, lime, while a plan runs", () => {
    expect(status({ ...createGoldenState(), plan: plan("active") })).toEqual({ tone: "on", mark: "on", text: "On duty · $500 held with PayPal" });
  });

  it("reads Deciding… while the autopilot decides (design/21 #4)", () => {
    expect(status({ ...createGoldenState(), plan: plan("active") }, "live", { deciding: true })).toEqual({
      tone: "on",
      mark: "deciding",
      text: "Deciding…",
    });
    // Only a running plan decides.
    expect(status(createGoldenState(), "live", { deciding: true }).mark).toBe("off");
  });

  it("says when bidding power isn't set", () => {
    expect(status({ ...createGoldenState(), holdCents: null })).toEqual({ tone: "off", mark: "off", text: "Bidding power not set" });
  });

  it("says since when Glim is paused", () => {
    expect(status({ ...createGoldenState(), plan: plan("paused") }, "live", { pausedAt: new Date("2026-11-08T05:15:00Z") })).toEqual({
      tone: "off",
      mark: "paused",
      text: "Paused since 9:15 PM",
    });
  });

  it("is off duty once bidding closed, in 11's words", () => {
    expect(status(createGoldenState(), "closed")).toEqual({ tone: "off", mark: "off", text: "Off duty since 9:30 PM" });
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
  it("is on, now that V1 (design/21) is approved", () => {
    expect(PLAN_CARDS_ARM_AUTOPILOT).toBe(true);
    expect(planCardsArmAutopilot()).toBe(process.env.GLIM_AUTOPILOT !== "off");
  });
});

describe("the card once bidding closes (design/22 #12, #22)", () => {
  const card = (facts: Parameters<typeof closingCard>[0]["facts"]) =>
    closingCard({ at: new Date("2026-11-08T05:30:00Z"), timezone: "America/Los_Angeles", slug: SLUG, facts });

  it("says what Jamie won and pays, with the receipt", () => {
    expect(card({ wonCents: 47_000, wonCount: 2, wonInPlan: 2, planLots: 2, holdCents: 50_000, charged: false })).toEqual({
      type: "closing",
      eyebrow: "9:30 PM · BIDDING CLOSED",
      line: "You won both lots in your plan. You’ll pay $470 with PayPal, and the other $30 will be released.",
      receipt: { label: "See my receipt", href: `/e/${SLUG}/receipt` },
    });
  });

  it("says nothing is charged when nothing was won, with no receipt", () => {
    expect(card({ wonCents: 0, wonCount: 0, wonInPlan: 0, planLots: 2, holdCents: 50_000, charged: false })).toMatchObject({
      line: "You didn’t win a lot tonight, so you won’t be charged. All $500 will be released.",
      receipt: null,
    });
  });

  it("names a win outside the plan by count, and reads in the past tense once charged", () => {
    expect(card({ wonCents: 9_000, wonCount: 1, wonInPlan: 1, planLots: 2, holdCents: 50_000, charged: true }).line).toBe(
      "You won 1 lot. You paid $90 with PayPal, and the other $410 was released.",
    );
  });
});
