/** Insights (design/28) on the seeded fixture: every figure the board draws, read from the database. */
import { describe, expect, it } from "vitest";

import { createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { getInsightsView, raisedSeries } from "@/server/settlement/insights";

import { getTestDatabase } from "../../helpers/database";

import { runGala } from "./support";

const { pool } = getTestDatabase();

async function insights(slug = FIXTURE_SLUG) {
  const view = await getInsightsView(slug, pool);
  if (!view) throw new Error(`No insights for ${slug}`);
  return view;
}

describe("Insights on the fixture at 9:30 PM, on the figures of 12", () => {
  it("has the board's KPIs, Limits kept and Hold utilization", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const view = await insights();

    expect(view.phase).toBe("ready");
    expect(view.raisedCents).toBe(816_000);
    expect(view.lots).toEqual({ total: 24, sold: 23, open: 0, withoutBids: [{ number: 22, title: "Golf Lesson with a Pro" }] });
    expect(view.bids).toEqual({ total: 306, glim: 96 });
    expect(view.winners).toEqual({ count: 19, glim: 9 });
    expect(view.bidders).toBe(86);
    expect(view.simulatedBidders).toBe(86);
    // The fixture is not a demo and has no real holds, so it keeps 12's lines and names no one simulated.
    expect(view.saySimulated).toBe(false);

    expect(view.limits).toMatchObject({ reached: 24, passed: 0, glimBids: 96, glimBidsWithin: 96 });
    expect(view.limits.shares).toHaveLength(37);
    expect(view.limits.shares.slice(0, 24).every((share) => share === 1)).toBe(true);
    expect(view.limits.shares[24]).toBeCloseTo(0.956, 3);
    expect(view.limits.shares.at(-1)).toBeCloseTo(0.75, 3);

    expect(view.holds).toMatchObject({ heldCents: 4_395_000, chargedCents: 816_000, nonWinners: 67 });
    expect(view.holds.winnerShares).toHaveLength(19);
    expect(Math.round((view.holds.winnerShares[0] ?? 0) * 100)).toBe(94);
    expect(Math.round((view.holds.winnerShares.at(-1) ?? 0) * 100)).toBe(52);
    expect(Math.round((view.holds.chargedCents / view.holds.winnerHoldCents) * 100)).toBe(71);
    expect(Math.round((view.holds.chargedCents / view.holds.heldCents) * 100)).toBe(19);
  });

  it("raises $8,160 from 7:00 to 9:30 PM in the board's sixteen steps", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const view = await insights();
    expect(view.raised).toHaveLength(16);
    expect(view.raised[0]).toEqual({ at: view.window.opensAt, cents: 0 });
    expect(view.raised.at(-1)).toEqual({ at: view.window.closesAt, cents: 816_000 });
    expect(view.raised.every((point, index) => index === 0 || point.cents >= (view.raised[index - 1]?.cents ?? 0))).toBe(true);
  });

  it("has the board's top five lots, with their values, bids, paddles and Glim", async () => {
    await createFixtureEvent({ moment: "closed", on: "2026-11-07" }, pool);
    const view = await insights();
    const sold = view.lotRows.filter((lot) => lot.paddleNumber !== null).sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0));
    expect(sold).toHaveLength(23);
    expect(sold.slice(0, 5).map((lot) => [lot.number, lot.title, lot.amountCents, lot.estimatedValueCents, lot.bids, lot.paddleNumber, lot.glim])).toEqual([
      [1, "Name the Next Shelter Puppy", 145_000, 0, 18, 175, false],
      [2, "Hot Air Balloon Ride for Two", 78_000, 50_000, 15, 168, false],
      [3, "Weekend Cabin Stay", 72_000, 60_000, 21, 104, false],
      [4, "Riverside Theater Season Tickets", 60_000, 48_000, 18, 121, true],
      [6, "Sailing Afternoon on the Bay", 52_000, 40_000, 13, 138, true],
    ]);
    expect(view.lotRows.find((lot) => lot.number === 22)).toMatchObject({ amountCents: null, bids: 0, paddleNumber: null });
  });

  it("says what is bid now while bidding runs, the line ending at now", async () => {
    await createFixtureEvent({ moment: "paddle", on: "2026-11-07" }, pool);
    const view = await insights();
    expect(view.phase).toBe("live");
    expect(view.lots.open).toBeGreaterThan(0);
    expect(view.raised.at(-1)?.at).toBeLessThanOrEqual(view.window.closesAt);
    expect(view.raised.at(-1)?.cents).toBe(view.raisedCents);
  });

  it("names the simulated guests in a demo", async () => {
    const gala = await runGala(pool, null, {
      isDemo: true,
      real: [{ number: 142, holdCents: 50_000 }],
      simulated: [{ number: 175, holdCents: 50_000 }],
      wins: [{ number: 175, lot: 1, cents: 10_000 }],
    });
    const view = await insights(gala.slug);
    expect(view).toMatchObject({ bidders: 2, simulatedBidders: 1, saySimulated: true });
  });

  it("is null for an unknown event", async () => {
    await expect(getInsightsView("no-such-event", pool)).resolves.toBeNull();
  });
});

describe("raisedSeries", () => {
  it("adds up each lot's high bid at each instant, never a lot's earlier bids", () => {
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 8, 3, minutes));
    const series = raisedSeries(
      [
        { lot_id: "a", amount_cents: 1_000, at: at(1) },
        { lot_id: "a", amount_cents: 2_000, at: at(2) },
        { lot_id: "b", amount_cents: 500, at: at(20) },
      ],
      at(0).getTime(),
      at(30).getTime(),
      at(30).getTime(),
    );
    expect(series).toHaveLength(16);
    expect(series[1]).toEqual({ at: at(2).getTime(), cents: 2_000 });
    expect(series.at(-1)).toEqual({ at: at(30).getTime(), cents: 2_500 });
  });

  it("stops at now while bidding runs", () => {
    const series = raisedSeries([], 0, 1_000, 3_000);
    expect(series.at(-1)?.at).toBe(1_000);
    expect(series.every((point) => point.at <= 1_000)).toBe(true);
  });
});
