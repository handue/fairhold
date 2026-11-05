import { describe, expect, it } from "vitest";

import {
  closeDueLots,
  closeEvent,
  createLimits,
  pauseLimits,
  placeBid,
  removeLimit,
  resumeLimits,
  setMaxBid,
  type EnginePayload,
} from "@/server/engine";

import { commitmentsOf, MemoryEngineStore, type MemoryLot } from "./support/memory-store";

/** One live event in the memory store, with helpers to add paddles and lots and read them back. */
function auction() {
  const store = new MemoryEngineStore();
  const engine = { store };
  const eventId = store.addEvent("live");
  return {
    store,
    engine,
    eventId,
    paddle(number: number, holdCents?: number): string {
      const id = store.addPaddle(eventId, number);
      if (holdCents !== undefined) store.addHold(id, holdCents);
      return id;
    },
    lot(number: number, startingBidCents: number, minRaiseCents: number, status: MemoryLot["status"] = "open") {
      return store.addLot(eventId, { number, startingBidCents, minRaiseCents, status });
    },
    lotState(lotId: string): MemoryLot {
      const lot = store.state.lots.get(lotId);
      if (!lot) throw new Error(`no lot ${lotId}`);
      return lot;
    },
    committed(paddleId: string): number {
      return commitmentsOf(store.state, paddleId).reduce((sum, row) => sum + row.cents, 0);
    },
    payloads(kind: EnginePayload["kind"], paddleId?: string | null) {
      return store.state.eventLog
        .filter((row) => row.payload.kind === kind && (paddleId === undefined || row.paddleId === paddleId))
        .map((row) => row.payload);
    },
  };
}

/** Bids that walk a lot up from its starting bid, alternating between two paddles. */
async function seedBids(t: ReturnType<typeof auction>, lotId: string, paddles: [string, string], count: number) {
  const lot = t.lotState(lotId);
  for (let index = 0; index < count; index += 1) {
    const amount = lot.startingBidCents + index * lot.minRaiseCents;
    const result = await placeBid(paddles[index % 2 === 0 ? 0 : 1], lotId, amount, "bot", t.engine);
    expect(result.ok).toBe(true);
  }
}

describe("the approved golden path", () => {
  it("reproduces Jamie's numbers from 05, 07 and 10", async () => {
    const t = auction();
    const jamie = t.paddle(142, 50_000);
    const paddle088 = t.paddle(88, 200_000);
    const director = t.paddle(31, 200_000);
    const chefsTable = t.lot(7, 10_000, 2_000);
    const spaDay = t.lot(12, 7_000, 500);
    const cabin = t.lot(3, 50_000, 2_000);

    await seedBids(t, chefsTable, [paddle088, director], 11);
    await seedBids(t, spaDay, [paddle088, director], 4);
    await seedBids(t, cabin, [paddle088, director], 8);
    expect(t.lotState(chefsTable)).toMatchObject({ currentBidCents: 30_000, bidCount: 11 });
    expect(t.lotState(spaDay)).toMatchObject({ currentBidCents: 8_500, bidCount: 4 });
    expect(t.lotState(cabin)).toMatchObject({ currentBidCents: 64_000 });

    // 05: Jamie keeps the next minimum and places the bid.
    const bid = await placeBid(jamie, chefsTable, 32_000, "guest", t.engine);
    expect(bid).toMatchObject({ ok: true, leading: true, lot: { bidCount: 12, nextMinimumCents: 34_000 } });
    expect(50_000 - t.committed(jamie)).toBe(18_000); // the nav pill's "$180 / $500"

    // 07: "Start bidding" on the $380 / $120 plan. Jamie already leads Chef's Table; Spa Day opens at $90.
    const plan = await createLimits(jamie, [
      { lotId: chefsTable, maxCents: 38_000 },
      { lotId: spaDay, maxCents: 12_000 },
    ], t.engine);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.bids).toEqual([expect.objectContaining({ lotId: spaDay, paddleId: jamie, amountCents: 9_000, source: "glim" })]);
    expect(t.lotState(spaDay)).toMatchObject({ currentBidCents: 9_000, bidCount: 5 });

    // The director bids $360 on Chef's Table; Glim answers at its $380 limit.
    const rival = await placeBid(director, chefsTable, 36_000, "bot", t.engine);
    expect(rival).toMatchObject({ ok: true, leading: false });
    if (!rival.ok) return;
    expect(rival.proxyBids).toEqual([expect.objectContaining({ paddleId: jamie, amountCents: 38_000, source: "glim" })]);
    expect(t.lotState(chefsTable)).toMatchObject({ currentBidCents: 38_000, bidCount: 14, highPaddleId: jamie });
    expect(t.payloads("limit_raised", jamie).at(-1)).toMatchObject({
      lotNumber: 7,
      triggerAmountCents: 36_000,
      amountCents: 38_000,
      limitCents: 38_000,
      owner: "glim",
      opening: false,
      leading: true,
    });

    // 10: $470 in winning bids, $30 of Glim's room left, and nothing more to commit.
    const leading = [chefsTable, spaDay].reduce((sum, lotId) => sum + (t.lotState(lotId).currentBidCents ?? 0), 0);
    expect(leading).toBe(47_000);
    expect(t.committed(jamie)).toBe(50_000);

    // "Can you also get me the cabin?" is refused with the numbers for a raise offer.
    const cabinBid = await placeBid(jamie, cabin, 66_000, "guest", t.engine);
    expect(cabinBid).toEqual({
      ok: false,
      refusal: {
        reason: "over_bidding_power",
        paddleId: jamie,
        lotIds: [cabin],
        holdCents: 50_000,
        committedElsewhereCents: 50_000,
        availableCents: 0,
        requiredCents: 66_000,
        shortfallCents: 66_000,
      },
    });
  });
});

describe("placeBid", () => {
  it("refuses below the next minimum and reports the minimum", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const lotId = t.lot(7, 10_000, 2_000);
    expect(await placeBid(guest, lotId, 9_999, "guest", t.engine)).toEqual({
      ok: false,
      refusal: { reason: "below_minimum", lotId, minimumCents: 10_000, amountCents: 9_999 },
    });
    await placeBid(guest, lotId, 10_000, "guest", t.engine);
    const rival = t.paddle(88, 50_000);
    expect(await placeBid(rival, lotId, 11_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "below_minimum", minimumCents: 12_000 },
    });
  });

  it("refuses a paddle without an authorized hold", async () => {
    const t = auction();
    const guest = t.paddle(142);
    const lotId = t.lot(7, 10_000, 2_000);
    expect(await placeBid(guest, lotId, 10_000, "guest", t.engine)).toEqual({
      ok: false,
      refusal: { reason: "no_hold", paddleId: guest },
    });
  });

  it("refuses lots that have not opened", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const draft = t.lot(7, 10_000, 2_000, "draft");
    expect(await placeBid(guest, draft, 10_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "not_open", lotStatus: "draft", eventStatus: "live" },
    });
  });

  it("refuses at closes_at even before the tick has closed the lot", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const lotId = t.lot(7, 10_000, 2_000);
    t.store.expireLot(lotId);
    expect(t.lotState(lotId).status).toBe("open");
    expect(await placeBid(guest, lotId, 10_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "lot_closed", lotId, closedAt: null },
    });
  });

  it("commits the new amount, not the sum, when a guest raises their own winning bid", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const first = t.lot(7, 10_000, 1_000);
    const second = t.lot(8, 5_000, 1_000);
    expect((await placeBid(guest, first, 30_000, "guest", t.engine)).ok).toBe(true);
    expect(await placeBid(guest, first, 45_000, "guest", t.engine)).toMatchObject({ ok: true, leading: true });
    expect(t.committed(guest)).toBe(45_000);
    expect(await placeBid(guest, second, 6_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", availableCents: 5_000, requiredCents: 6_000, shortfallCents: 1_000 },
    });
    expect((await placeBid(guest, second, 5_000, "guest", t.engine)).ok).toBe(true);
  });

  it("releases a commitment when the paddle is outbid", async () => {
    const t = auction();
    const guest = t.paddle(142, 30_000);
    const rival = t.paddle(88, 100_000);
    const first = t.lot(7, 30_000, 1_000);
    const second = t.lot(8, 30_000, 1_000);
    await placeBid(guest, first, 30_000, "guest", t.engine);
    expect((await placeBid(guest, second, 30_000, "guest", t.engine)).ok).toBe(false);
    await placeBid(rival, first, 31_000, "guest", t.engine);
    expect((await placeBid(guest, second, 30_000, "guest", t.engine)).ok).toBe(true);
  });

  it("logs the public bid and tells the paddle it outbid", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const rival = t.paddle(88, 50_000);
    const lotId = t.lot(7, 10_000, 2_000);
    await placeBid(rival, lotId, 30_000, "guest", t.engine);
    await placeBid(guest, lotId, 32_000, "guest", t.engine);
    expect(t.payloads("bids_placed").at(-1)).toMatchObject({
      lotNumber: 7,
      bids: [{ paddleNumber: 142, amountCents: 32_000, source: "guest" }],
      currentBidCents: 32_000,
      bidCount: 2,
      highPaddleNumber: 142,
      nextMinimumCents: 34_000,
    });
    expect(t.payloads("outbid", rival)).toEqual([
      expect.objectContaining({ yourBidCents: 30_000, currentBidCents: 32_000, nextMinimumCents: 34_000 }),
    ]);
  });
});

describe("limits", () => {
  it("bids a new max right away when the guest is not leading, and not when leading", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const rival = t.paddle(88, 50_000);
    const lotId = t.lot(7, 10_000, 2_000);
    await placeBid(rival, lotId, 10_000, "guest", t.engine);
    const set = await setMaxBid(guest, lotId, 20_000, t.engine);
    expect(set).toMatchObject({ ok: true, leading: true, bids: [{ amountCents: 12_000, source: "guest_max" }] });
    const raised = await setMaxBid(guest, lotId, 30_000, t.engine);
    expect(raised).toMatchObject({ ok: true, leading: true, bids: [] });
    expect(t.committed(guest)).toBe(30_000);
  });

  it("refuses a max below the next minimum or beyond the hold", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const lotId = t.lot(7, 10_000, 2_000);
    expect(await setMaxBid(guest, lotId, 9_000, t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "below_minimum", minimumCents: 10_000 },
    });
    expect(await setMaxBid(guest, lotId, 60_000, t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", availableCents: 50_000, requiredCents: 60_000 },
    });
    expect(t.store.state.limits.size).toBe(0);
  });

  it("keeps a lot at its limit through a plan change: the leader's own bid is a valid max", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const rival = t.paddle(88, 50_000);
    const chefsTable = t.lot(7, 10_000, 2_000);
    const spa = t.lot(12, 4_000, 500);
    await createLimits(guest, [{ lotId: chefsTable, maxCents: 38_000 }, { lotId: spa, maxCents: 12_000 }], t.engine);
    await placeBid(rival, chefsTable, 36_000, "guest", t.engine);
    expect(t.committed(guest)).toBe(50_000);

    // Chef's Table sits at its $380 limit (next minimum $400); the edit keeps it and drops the spa.
    const edit = await createLimits(guest, [{ lotId: chefsTable, maxCents: 38_000 }], {
      ...t.engine,
      removeLotIds: [spa],
    });
    expect(edit).toMatchObject({ ok: true, bids: [], limits: [{ maxCents: 38_000, active: true }] });
    expect(t.committed(guest)).toBe(38_000 + 4_000);

    expect(await setMaxBid(guest, chefsTable, 37_000, t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "below_minimum", minimumCents: 38_000, amountCents: 37_000 },
    });
    // Once outbid, the limit cannot answer and is exhausted, freeing its hold.
    await placeBid(rival, chefsTable, 40_000, "guest", t.engine);
    expect(t.committed(guest)).toBe(4_000);
  });

  it("runs a proxy war by the minimum raise until the lower max is spent", async () => {
    const t = auction();
    const high = t.paddle(1, 100_000);
    const low = t.paddle(2, 100_000);
    const lotId = t.lot(7, 10_000, 2_000);
    await setMaxBid(high, lotId, 50_000, t.engine);
    const war = await setMaxBid(low, lotId, 40_000, t.engine);
    expect(war).toMatchObject({ ok: true, leading: false });
    expect(t.lotState(lotId)).toMatchObject({ currentBidCents: 42_000, highPaddleId: high, bidCount: 17 });
    expect(t.payloads("limit_exhausted", low)).toEqual([
      expect.objectContaining({ limitCents: 40_000, currentBidCents: 42_000 }),
    ]);
    expect(t.committed(low)).toBe(0);
    expect(t.committed(high)).toBe(50_000);
  });

  it("lets the older of two equal maxes answer first", async () => {
    const t = auction();
    const older = t.paddle(1, 100_000);
    const newer = t.paddle(2, 100_000);
    const caller = t.paddle(3, 100_000);
    const lotId = t.lot(7, 10_000, 1_000);
    // Both limits are paused while a third paddle leads, then both wake on the same bid.
    await createLimits(older, [{ lotId, maxCents: 30_000 }], t.engine);
    await pauseLimits(older, t.engine);
    await createLimits(newer, [{ lotId, maxCents: 30_000 }], t.engine);
    await pauseLimits(newer, t.engine);
    await placeBid(caller, lotId, 12_000, "guest", t.engine);
    t.store.mutate((state) => {
      for (const limit of state.limits.values()) limit.pausedAt = null;
    });
    const result = await placeBid(caller, lotId, 13_000, "guest", t.engine);
    expect(result.ok && result.proxyBids[0]).toMatchObject({ paddleId: older, amountCents: 14_000 });
  });

  it("keeps a paused limit's hold reserved and answers missed bids on resume", async () => {
    const t = auction();
    const guest = t.paddle(142, 30_000);
    const rival = t.paddle(88, 100_000);
    const lotId = t.lot(7, 10_000, 2_000);
    const other = t.lot(8, 5_000, 1_000);
    await createLimits(guest, [{ lotId, maxCents: 25_000 }], t.engine);
    expect(await pauseLimits(guest, t.engine)).toMatchObject({ ok: true, limitIds: [expect.any(String)] });

    await placeBid(rival, lotId, 16_000, "guest", t.engine);
    expect(t.lotState(lotId).highPaddleId).toBe(rival);
    expect(await placeBid(guest, other, 6_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", availableCents: 5_000 },
    });

    const resumed = await resumeLimits(guest, t.engine);
    expect(resumed.bids).toEqual([expect.objectContaining({ paddleId: guest, amountCents: 18_000, source: "glim" })]);
  });

  it("frees the hold when a limit is removed or spent, and keeps the bids it placed", async () => {
    const t = auction();
    const guest = t.paddle(142, 30_000);
    const rival = t.paddle(88, 100_000);
    const lotId = t.lot(7, 10_000, 2_000);
    await createLimits(guest, [{ lotId, maxCents: 30_000 }], t.engine);
    expect(t.committed(guest)).toBe(30_000);
    expect(await removeLimit(guest, lotId, { ...t.engine, owner: "glim" })).toMatchObject({
      ok: true,
      removed: { maxCents: 30_000, active: false },
    });
    expect(t.committed(guest)).toBe(10_000);
    expect(t.lotState(lotId)).toMatchObject({ highPaddleId: guest, currentBidCents: 10_000 });

    await setMaxBid(guest, lotId, 20_000, t.engine);
    await placeBid(rival, lotId, 30_000, "guest", t.engine);
    expect(t.committed(guest)).toBe(0);
  });

  it("counts a manual bid above the guest's own max at the bid", async () => {
    const t = auction();
    const guest = t.paddle(142, 40_000);
    const lotId = t.lot(7, 10_000, 2_000);
    const other = t.lot(8, 5_000, 1_000);
    await setMaxBid(guest, lotId, 20_000, t.engine);
    await placeBid(guest, lotId, 35_000, "guest", t.engine);
    expect(t.committed(guest)).toBe(35_000);
    expect(await placeBid(guest, other, 6_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", availableCents: 5_000 },
    });
  });

  it("creates a plan all or nothing", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const open = t.lot(7, 10_000, 2_000);
    const expired = t.lot(8, 5_000, 1_000);
    t.store.expireLot(expired);
    const plan = await createLimits(guest, [
      { lotId: open, maxCents: 20_000 },
      { lotId: expired, maxCents: 10_000 },
    ], t.engine);
    expect(plan).toMatchObject({ ok: false, refusal: { reason: "lot_closed", lotId: expired } });
    expect(t.store.state.limits.size).toBe(0);
    expect(t.store.state.bids).toHaveLength(0);
  });

  it("checks the whole plan against the hold, counting every max", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const first = t.lot(7, 10_000, 2_000);
    const second = t.lot(8, 5_000, 1_000);
    expect(
      await createLimits(guest, [
        { lotId: first, maxCents: 38_000 },
        { lotId: second, maxCents: 13_000 },
      ], t.engine),
    ).toMatchObject({
      ok: false,
      refusal: { reason: "over_bidding_power", requiredCents: 51_000, availableCents: 50_000, shortfallCents: 1_000 },
    });
  });

  it("replaces a guest max on the same lot and drops lots in the same transaction", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const first = t.lot(7, 10_000, 2_000);
    const second = t.lot(8, 5_000, 1_000);
    await setMaxBid(guest, first, 20_000, t.engine);
    await createLimits(guest, [{ lotId: second, maxCents: 10_000 }], t.engine);
    const edited = await createLimits(guest, [{ lotId: first, maxCents: 40_000 }], {
      ...t.engine,
      removeLotIds: [second],
    });
    expect(edited).toMatchObject({ ok: true, limits: [{ lotId: first, maxCents: 40_000, owner: "glim" }] });
    const active = [...t.store.state.limits.values()].filter((limit) => limit.active);
    expect(active).toEqual([expect.objectContaining({ lotId: first, maxCents: 40_000, owner: "glim" })]);
    expect(t.committed(guest)).toBe(40_000 + 5_000);
  });

  it("does not let a limit answer for a paddle whose hold is gone", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const rival = t.paddle(88, 100_000);
    const lotId = t.lot(7, 10_000, 2_000);
    await setMaxBid(guest, lotId, 30_000, t.engine);
    t.store.mutate((state) => {
      for (const hold of state.holds.values()) if (hold.paddleId === guest) hold.status = "voided";
    });
    const result = await placeBid(rival, lotId, 12_000, "guest", t.engine);
    expect(result).toMatchObject({ ok: true, leading: true, proxyBids: [] });
    expect(t.payloads("limit_blocked", guest)).toEqual([
      expect.objectContaining({ reason: "no_hold", amountCents: 14_000 }),
    ]);
  });
});

describe("closing", () => {
  it("closes only due lots, fixes the winner and ends their limits", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const rival = t.paddle(88, 50_000);
    const due = t.lot(7, 10_000, 2_000);
    const later = t.lot(8, 5_000, 1_000);
    await setMaxBid(guest, due, 30_000, t.engine);
    await placeBid(rival, due, 20_000, "guest", t.engine);
    t.store.expireLot(due);

    const result = await closeDueLots(undefined, t.engine);
    expect(result).toEqual({
      closedLots: [expect.objectContaining({ lotId: due, winningPaddleId: guest, winningCents: 22_000 })],
      closedEventIds: [],
    });
    expect(t.lotState(due)).toMatchObject({ status: "closed", winningPaddleId: guest, winningCents: 22_000 });
    expect(t.lotState(later).status).toBe("open");
    expect([...t.store.state.limits.values()].some((limit) => limit.active)).toBe(false);
    expect(t.committed(guest)).toBe(22_000);
    expect(t.payloads("lot_won", guest)).toEqual([expect.objectContaining({ amountCents: 22_000 })]);
    expect(t.payloads("lot_lost", rival)).toEqual([expect.objectContaining({ winningCents: 22_000 })]);

    expect(await closeDueLots(undefined, t.engine)).toEqual({ closedLots: [], closedEventIds: [] });
  });

  it("never closes a lot before closes_at, whatever clock the caller passes", async () => {
    const t = auction();
    const lotId = t.lot(7, 10_000, 2_000);
    const aheadOfTheDatabase = new Date(t.store.state.clock + 2 * 60 * 60 * 1000);
    expect((await closeDueLots(aheadOfTheDatabase, t.engine)).closedLots).toHaveLength(0);

    t.store.expireLot(lotId);
    const beforeTheClose = new Date(t.lotState(lotId).closesAt - 1);
    expect((await closeDueLots(beforeTheClose, t.engine)).closedLots).toHaveLength(0);
    expect((await closeDueLots(undefined, t.engine)).closedLots).toHaveLength(1);
  });

  it("closes the event once its last lot closes", async () => {
    const t = auction();
    const first = t.lot(7, 10_000, 2_000);
    const second = t.lot(8, 5_000, 1_000);
    t.store.expireLot(first);
    expect((await closeDueLots(undefined, t.engine)).closedEventIds).toEqual([]);
    t.store.expireLot(second);
    expect((await closeDueLots(undefined, t.engine)).closedEventIds).toEqual([t.eventId]);
    expect(t.store.state.events.get(t.eventId)?.status).toBe("closed");
    expect(t.payloads("event_closed")).toHaveLength(1);
  });

  it("closes every lot and the event at once with closeEvent, idempotently", async () => {
    const t = auction();
    const guest = t.paddle(142, 50_000);
    const first = t.lot(7, 10_000, 2_000);
    const second = t.lot(8, 5_000, 1_000);
    await placeBid(guest, first, 10_000, "guest", t.engine);
    const closesBefore = t.lotState(second).closesAt;

    const result = await closeEvent(t.eventId, t.engine);
    expect(result).toMatchObject({ eventClosed: true, closedLots: [{}, {}] });
    expect(t.lotState(first)).toMatchObject({ status: "closed", winningPaddleId: guest, winningCents: 10_000 });
    expect(t.lotState(second)).toMatchObject({ status: "closed", winningPaddleId: null, winningCents: null });
    expect(t.lotState(second).closesAt).toBeLessThan(closesBefore);
    expect(await placeBid(guest, second, 5_000, "guest", t.engine)).toMatchObject({
      ok: false,
      refusal: { reason: "lot_closed" },
    });

    expect(await closeEvent(t.eventId, t.engine)).toEqual({ closedLots: [], eventClosed: false });
  });
});
