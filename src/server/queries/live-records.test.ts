import { describe, expect, it } from "vitest";

import type { StreamEvent } from "@/server/sse/types";
import { riversideFixtureSource } from "@/ui/__fixtures__/riverside";

import { buildCatalogView, getCatalogSeed } from "./catalog";
import { foldStreamRows } from "./live-records";
import { buildLotDetailView, getLotDetailSeed } from "./lot";
import type { GuestReadSource } from "./types";

const SLUG = "riverside-shelter-gala";
const JAMIE = "paddle-142";

async function catalogSeed() {
  const seed = await getCatalogSeed({ slug: SLUG, paddleNumber: 142, category: null }, riversideFixtureSource);
  if (!seed) throw new Error("the fixture event is missing");
  return { ...seed, streamPosition: "100" };
}

async function lotSeed(lotNumber: number) {
  const seed = await getLotDetailSeed({ slug: SLUG, lotNumber, paddleNumber: 142 }, riversideFixtureSource);
  if (!seed) throw new Error("the fixture lot is missing");
  return { ...seed, streamPosition: "100" };
}

let nextId = 101;
const row = (fields: { type: StreamEvent["type"]; paddleId: string | null; payload: object }, at = 1_000): StreamEvent =>
  ({ id: String(nextId++), at, ...fields }) as unknown as StreamEvent;

function bidsPlaced(lotId: string, lotNumber: number, cents: number, bidCount: number, paddleId: string, paddleNumber: number, at?: number) {
  return row(
    {
      type: "bid",
      paddleId: null,
      payload: {
        kind: "bids_placed",
        lotId,
        lotNumber,
        bids: [{ bidId: `b${cents}`, paddleId, paddleNumber, amountCents: cents, source: "guest" }],
        currentBidCents: cents,
        bidCount,
        highPaddleId: paddleId,
        highPaddleNumber: paddleNumber,
        nextMinimumCents: cents + 2_000,
      },
    },
    at,
  );
}

describe("foldStreamRows", () => {
  it("returns the seed itself when no row comes after its position", async () => {
    const seed = await catalogSeed();
    expect(foldStreamRows(seed, [])).toBe(seed);
    const old = { ...bidsPlaced("lot-7", 7, 34_000, 13, "p88", 88), id: "100" } as StreamEvent;
    expect(foldStreamRows(seed, [old])).toBe(seed);
  });

  it("flips a winning tile to outbid and gives the bid back to the nav, the band and the raised total", async () => {
    const seed = await catalogSeed();
    const before = buildCatalogView(seed);
    const chef = seed.lots.find((lot) => lot.number === 7);
    if (!chef) throw new Error("no lot 7");

    const view = buildCatalogView(foldStreamRows(seed, [bidsPlaced(chef.id, 7, 34_000, 13, "p88", 88)]));

    expect(view.lots.find((lot) => lot.number === 7)).toMatchObject({ viewerStatus: "outbid", priceCents: 34_000, bidCount: 13 });
    expect(view.viewer).toMatchObject({ winningCount: 0, outbidCount: 2, availableCents: 50_000 });
    expect(view.raisedCents).toBe(before.raisedCents + 2_000);
  });

  it("reads a bid of the viewer's as winning, and marks the lot as bid on", async () => {
    const seed = await catalogSeed();
    const spa = seed.lots.find((lot) => lot.number === 12);
    if (!spa) throw new Error("no lot 12");
    expect(buildCatalogView(seed).lots.find((lot) => lot.number === 12)?.offerGlimWatch).toBe(true);

    const view = buildCatalogView(foldStreamRows(seed, [bidsPlaced(spa.id, 12, 9_000, 3, JAMIE, 142)]));

    expect(view.lots.find((lot) => lot.number === 12)).toMatchObject({ viewerStatus: "winning", offerGlimWatch: false });
    expect(view.viewer?.winningCount).toBe(2);
  });

  it("moves 05's presets, history and next minimum with a rival's bid", async () => {
    const seed = await lotSeed(7);
    const view = buildLotDetailView(foldStreamRows(seed, [bidsPlaced(seed.lot.id, 7, 34_000, 13, "p88", 88, 5_000)]));

    expect(view.lot).toMatchObject({
      viewerStatus: "outbid",
      currentBidCents: 34_000,
      bidCount: 13,
      nextMinimumCents: 36_000,
      presetCents: [36_000, 38_000, 42_000],
    });
    expect(view.history).toEqual([
      { paddleNumber: 88, isViewer: false, amountCents: 34_000, placedAt: 5_000 },
      { paddleNumber: 142, isViewer: true, amountCents: 32_000, placedAt: seed.bids[0]?.createdAt },
    ]);
  });

  it("lists every bid of one action in the history, highest first", async () => {
    const seed = await lotSeed(7);
    const bid = (bidId: string, paddleId: string, paddleNumber: number, amountCents: number) => ({
      bidId,
      paddleId,
      paddleNumber,
      amountCents,
      source: "guest_max" as const,
    });
    const placed = row({
      type: "bid",
      paddleId: null,
      payload: {
        kind: "bids_placed",
        lotId: seed.lot.id,
        lotNumber: 7,
        bids: [bid("a", "p88", 88, 34_000), bid("b", JAMIE, 142, 36_000)],
        currentBidCents: 36_000,
        bidCount: 14,
        highPaddleId: JAMIE,
        highPaddleNumber: 142,
        nextMinimumCents: 38_000,
      },
    });

    const view = buildLotDetailView(foldStreamRows(seed, [placed]));

    expect(view.history.map((entry) => entry.amountCents)).toEqual([36_000, 34_000]);
    expect(view.lot.viewerStatus).toBe("winning");
  });

  it("does not repeat a bid the page's read already included", async () => {
    const seed = await lotSeed(7);
    const replayed = bidsPlaced(seed.lot.id, 7, 32_000, 12, JAMIE, 142);
    const view = buildLotDetailView(foldStreamRows(seed, [replayed]));
    expect(view.history).toEqual(buildLotDetailView(seed).history);
    expect(view.lot.bidCount).toBe(12);
  });

  it("closes a lot, leaving the nav charged for the win and the limit gone", async () => {
    const seed = await lotSeed(7);
    const closed = row(
      {
        type: "lot_closed",
        paddleId: null,
        payload: {
          kind: "lot_closed",
          lotId: seed.lot.id,
          lotNumber: 7,
          winningPaddleId: JAMIE,
          winningPaddleNumber: 142,
          winningCents: 32_000,
          bidCount: 12,
        },
      },
      seed.lot.closesAt + 500,
    );

    const view = buildLotDetailView(foldStreamRows(seed, [closed]));

    expect(view.lot).toMatchObject({ status: "closed", viewerStatus: "won", limitCents: null, closesAt: seed.lot.closesAt });
    expect(view.viewer).toMatchObject({ winningCount: 0, availableCents: 18_000 });
  });

  it("takes a forced close's time as the moment it closed", async () => {
    const seed = await lotSeed(7);
    const at = seed.lot.closesAt - 60_000;
    const closed = row(
      {
        type: "lot_closed",
        paddleId: null,
        payload: {
          kind: "lot_closed",
          lotId: seed.lot.id,
          lotNumber: 7,
          winningPaddleId: null,
          winningPaddleNumber: null,
          winningCents: null,
          bidCount: 12,
        },
      },
      at,
    );
    expect(buildLotDetailView(foldStreamRows(seed, [closed])).lot.closesAt).toBe(at);
  });

  it("follows the event's status and a moved schedule", async () => {
    const seed = await catalogSeed();
    const chef = seed.lots.find((lot) => lot.number === 7);
    if (!chef) throw new Error("no lot 7");
    const moved = row({
      type: "event_status",
      paddleId: null,
      payload: { kind: "schedule_changed", closesAt: 9_000_000, lots: [{ lotId: chef.id, lotNumber: 7, closesAt: 8_000_000 }] },
    });
    // Closing on schedule, a moment after its time: the schedule is still the time to show.
    const closed = row({ type: "event_status", paddleId: null, payload: { kind: "event_closed", status: "closed" } }, 9_000_500);

    const view = buildCatalogView(foldStreamRows(seed, [moved, closed]));

    expect(view.event).toMatchObject({ status: "closed", closesAt: 9_000_000 });
    expect(view.lots.find((lot) => lot.number === 7)?.closesAt).toBe(8_000_000);
  });

  it("says when the event really closed, when it closed ahead of its schedule", async () => {
    const seed = await catalogSeed();
    const at = seed.event.closesAt - 600_000;
    const closed = row({ type: "event_status", paddleId: null, payload: { kind: "event_closed", status: "closed" } }, at);

    expect(buildCatalogView(foldStreamRows(seed, [closed])).event).toMatchObject({ status: "closed", closesAt: at });
  });

  describe("holds", () => {
    const hold = (paddleId: string, payload: object) => row({ type: "hold", paddleId, payload });

    it("takes the hold when it lands, through a raise, and drops it when it ends", async () => {
      const seed = { ...(await catalogSeed()), paddle: { id: JAMIE, number: 142, firstName: "Jamie", holdCents: null, holdId: null } };

      const held = foldStreamRows(seed, [hold(JAMIE, { holdId: "h1", status: "authorized", amountCents: 50_000 })]);
      expect(held.paddle).toMatchObject({ holdCents: 50_000, holdId: "h1" });

      const raised = foldStreamRows(held, [
        hold(JAMIE, { holdId: "h2", status: "authorized", amountCents: 70_000 }),
        hold(JAMIE, { holdId: "h1", status: "replaced", replacedByHoldId: "h2" }),
        hold(JAMIE, { holdId: "h1", status: "voided" }),
      ]);
      expect(raised.paddle).toMatchObject({ holdCents: 70_000, holdId: "h2" });

      const captured = foldStreamRows(raised, [hold(JAMIE, { holdId: "h2", status: "captured" })]);
      expect(captured.paddle?.holdCents).toBeNull();
    });

    it("keeps the hold in place when an approval is refused", async () => {
      const seed = { ...(await catalogSeed()), paddle: { id: JAMIE, number: 142, firstName: "Jamie", holdCents: 50_000, holdId: "h1" } };
      const refused = hold(JAMIE, { holdId: "h9", status: "replaced", amountCents: 30_000, reason: "not_a_raise", replacedByHoldId: "h1" });
      expect(foldStreamRows(seed, [refused]).paddle).toMatchObject({ holdCents: 50_000, holdId: "h1" });
    });

    it("ignores another paddle's holds, which an organizer also receives", async () => {
      const seed = await catalogSeed();
      const other = hold("p88", { holdId: "h7", status: "authorized", amountCents: 90_000 });
      expect(foldStreamRows(seed, [other]).paddle?.holdCents).toBe(50_000);
    });
  });

  describe("the viewer's limits and hearts", () => {
    const limit = { limitId: "l1", planItemId: "i1" };
    const own = (payload: object, type: "bid" | "glim" = "glim") => row({ type, paddleId: JAMIE, payload });

    it("follows a Glim limit from set to exhausted to removed", async () => {
      const seed = await lotSeed(12);
      const lot = { lotId: seed.lot.id, lotNumber: 12 };

      const set = foldStreamRows(seed, [own({ kind: "limit_set", ...lot, ...limit, owner: "glim", maxCents: 12_000, replacedLimitId: null })]);
      expect(buildLotDetailView(set).lot.limitCents).toBe(12_000);
      expect(set.viewerLots.find((relation) => relation.lotId === seed.lot.id)?.inGlimPlan).toBe(true);

      const ran = foldStreamRows(set, [own({ kind: "limit_exhausted", ...lot, ...limit, owner: "glim", limitCents: 12_000, currentBidCents: 13_000 })]);
      expect(buildLotDetailView(ran).lot.limitCents).toBeNull();
      expect(ran.viewerLots.find((relation) => relation.lotId === seed.lot.id)?.inGlimPlan).toBe(true);

      const skipped = foldStreamRows(ran, [own({ kind: "limit_removed", ...lot, ...limit, owner: "glim" })]);
      expect(skipped.viewerLots.find((relation) => relation.lotId === seed.lot.id)?.inGlimPlan).toBe(false);
    });

    it("does not count a guest's own max as being in Glim's plan", async () => {
      const seed = await lotSeed(3);
      const lot = { lotId: seed.lot.id, lotNumber: 3 };
      const folded = foldStreamRows(seed, [
        own({ kind: "limit_set", ...lot, limitId: "l2", planItemId: null, owner: "guest_max", maxCents: 12_000, replacedLimitId: null }, "bid"),
      ]);
      expect(folded.viewerLots.find((relation) => relation.lotId === seed.lot.id)).toMatchObject({ limitCents: 12_000, inGlimPlan: false });
    });

    it("follows the heart, which drives 08's Let Glim watch", async () => {
      const seed = await catalogSeed();
      const lot = seed.lots.find((candidate) => candidate.number === 3);
      if (!lot) throw new Error("no lot 3");
      const hearted = foldStreamRows(seed, [own({ kind: "favorite_changed", lotId: lot.id, lotNumber: 3, isFavorite: true }, "bid")]);
      expect(buildCatalogView(hearted).lots.find((candidate) => candidate.number === 3)?.offerGlimWatch).toBe(true);

      const unhearted = foldStreamRows(hearted, [own({ kind: "favorite_changed", lotId: lot.id, lotNumber: 3, isFavorite: false }, "bid")]);
      expect(buildCatalogView(unhearted).lots.find((candidate) => candidate.number === 3)?.offerGlimWatch).toBe(false);
    });

    it("ignores private rows that are not the viewer's", async () => {
      const seed = await lotSeed(12);
      const stray = row({
        type: "glim",
        paddleId: "p88",
        payload: { kind: "limit_set", lotId: seed.lot.id, lotNumber: 12, ...limit, owner: "glim", maxCents: 99_000, replacedLimitId: null },
      });
      expect(buildLotDetailView(foldStreamRows(seed, [stray])).lot.limitCents).toBeNull();
    });
  });

  it("lands in the same place however often the rows are replayed", async () => {
    const seed = await lotSeed(7);
    const rows = [
      bidsPlaced(seed.lot.id, 7, 34_000, 13, "p88", 88, 2_000),
      bidsPlaced(seed.lot.id, 7, 36_000, 14, JAMIE, 142, 3_000),
    ];
    const once = foldStreamRows(seed, rows);
    const midway = foldStreamRows({ ...seed, streamPosition: rows[0]?.id ?? "" }, rows);
    expect(buildLotDetailView(once).lot.currentBidCents).toBe(36_000);
    expect(buildLotDetailView(midway).lot.currentBidCents).toBe(36_000);
    expect(foldStreamRows(once, rows)).toBe(once);
  });
});

describe("a page's read", () => {
  /** Every read of the fixture, in the order it was asked for. */
  function recording() {
    const calls: string[] = [];
    const reads = { ...riversideFixtureSource, streamPosition: async () => "4817" };
    const source = Object.fromEntries(
      Object.entries(reads).map(([name, read]) => [
        name,
        (...args: unknown[]) => {
          calls.push(name);
          return (read as (...args: unknown[]) => unknown)(...args);
        },
      ]),
    ) as unknown as GuestReadSource;
    return { calls, source };
  }

  it("takes the stream position before anything it covers, on 08", async () => {
    const { calls, source } = recording();
    const seed = await getCatalogSeed({ slug: SLUG, paddleNumber: 142, category: null }, source);
    expect(seed?.streamPosition).toBe("4817");
    expect(calls[0]).toBe("streamPosition");
    expect(calls.slice(1)).toContain("listLots");
  });

  it("takes the stream position before anything it covers, on 05", async () => {
    const { calls, source } = recording();
    const seed = await getLotDetailSeed({ slug: SLUG, lotNumber: 7, paddleNumber: 142 }, source);
    expect(seed?.streamPosition).toBe("4817");
    expect(calls[0]).toBe("streamPosition");
    expect(calls.slice(1)).toEqual(expect.arrayContaining(["listLots", "listLatestBids", "listViewerLots"]));
  });

  it("starts at the beginning on a source with no stream, like the fixture", async () => {
    const seed = await getCatalogSeed({ slug: SLUG, paddleNumber: 142, category: null }, riversideFixtureSource);
    expect(seed?.streamPosition).toBe("0");
  });
});
