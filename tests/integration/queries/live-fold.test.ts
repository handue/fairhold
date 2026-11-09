/**
 * What makes the browser's live pages trustworthy: folding the stream's rows over the rows a page
 * read lands exactly where a fresh read from Postgres does, whatever happened in between. The actions
 * are the real ones (the engine, the favorites route's writer, the plan writer); the rows are read
 * the way the stream reads them, for this viewer alone.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { closeDueLots, closeEvent, createLimits, nextMinimumCents, placeBid, removeLimit, setMaxBid } from "@/server/engine";
import { skipLot } from "@/server/plans/apply";
import { buildCatalogView, getCatalogSeed } from "@/server/queries/catalog";
import { setFavorite } from "@/server/queries/favorites";
import { foldStreamRows } from "@/server/queries/live-records";
import { buildLotDetailView, getLotDetailSeed } from "@/server/queries/lot";
import { createPostgresGuestSource } from "@/server/queries/postgres-source";
import type { CatalogView, GuestReadSource, LotDetailView } from "@/server/queries/types";
import { appendEventLog } from "@/server/sse/notify";
import { latestPosition, readVisibleRows } from "@/server/sse/rows";
import type { StreamEvent } from "@/server/sse/types";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createHold, createLot, createPaddle, expireLot } from "../engine/support/fixtures";
import { createGala, heart, startBidding } from "../plans/support";
import { slugOf } from "../sse/support";

const { pool, db } = getTestDatabase();
const source: GuestReadSource = createPostgresGuestSource(db);

const SECONDS = 1_000;
const RUNS = Number(process.env.LIVE_FOLD_RUNS ?? 12);

interface Gala {
  eventId: string;
  slug: string;
  /** The first is the viewer. */
  paddles: { id: string; number: number }[];
  lots: { id: string; number: number }[];
}

async function gala(): Promise<Gala> {
  const eventId = await createEvent(pool);
  const paddles = [];
  for (const number of [142, 88, 90]) {
    const id = await createPaddle(pool, eventId, number);
    await createHold(pool, eventId, id, 60_000);
    paddles.push({ id, number });
  }
  const lots = [];
  for (const number of [7, 9, 12]) {
    lots.push({ id: await createLot(pool, eventId, { number, startingBidCents: 5_000, minRaiseCents: 1_000 }), number });
  }
  return { eventId, slug: await slugOf(pool, eventId), paddles, lots };
}

type Action =
  | { kind: "bid"; who: number; lot: number; extraRaises: number }
  | { kind: "max"; who: number; lot: number; extraRaises: number }
  | { kind: "removeMax"; who: number; lot: number }
  | { kind: "glimLimit"; who: number; lot: number; extraRaises: number }
  | { kind: "heart"; who: number; lot: number; on: boolean }
  | { kind: "raiseHold"; who: number; cents: number }
  | { kind: "endHold"; who: number }
  | { kind: "closeLot"; lot: number }
  | { kind: "closeAll" };

const who = fc.integer({ min: 0, max: 2 });
const lot = fc.integer({ min: 0, max: 2 });
const extraRaises = fc.integer({ min: 0, max: 6 });
const actionArbitrary: fc.Arbitrary<Action> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("bid" as const), who, lot, extraRaises }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("max" as const), who, lot, extraRaises }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("removeMax" as const), who, lot }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("glimLimit" as const), who, lot, extraRaises }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("heart" as const), who, lot, on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("raiseHold" as const), who, cents: fc.integer({ min: 61_000, max: 90_000 }) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("endHold" as const), who }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("closeLot" as const), lot }) },
  { weight: 1, arbitrary: fc.constant({ kind: "closeAll" as const }) },
);

async function nextMinimum(lotId: string): Promise<{ next: number; raise: number }> {
  const { rows } = await pool.query<{
    highPaddleId: string | null;
    currentBidCents: number | null;
    startingBidCents: number;
    minRaiseCents: number;
  }>(
    `select high_paddle_id as "highPaddleId", current_bid_cents as "currentBidCents",
       starting_bid_cents as "startingBidCents", min_raise_cents as "minRaiseCents"
     from lots where id = $1`,
    [lotId],
  );
  const row = rows[0];
  if (!row) throw new Error("no lot");
  return { next: nextMinimumCents(row), raise: row.minRaiseCents };
}

/** A raise as the PayPal store records it: the new hold in place, the old one replaced, in one transaction. */
async function raiseHold(gala: Gala, paddleId: string, cents: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      "update holds set status = 'replaced' where paddle_id = $1 and status = 'authorized' returning id",
      [paddleId],
    );
    const inserted = await client.query<{ id: string }>(
      `insert into holds (event_id, paddle_id, kind, amount_cents, status, authorized_at)
       values ($1, $2, 'simulated', $3, 'authorized', now()) returning id`,
      [gala.eventId, paddleId, cents],
    );
    const holdId = inserted.rows[0]?.id ?? "";
    await appendEventLog(client, [
      { eventId: gala.eventId, paddleId, type: "hold", payload: { holdId, status: "authorized", amountCents: cents } },
      ...rows.map((row) => ({
        eventId: gala.eventId,
        paddleId,
        type: "hold" as const,
        payload: { holdId: row.id, status: "replaced", replacedByHoldId: holdId },
      })),
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** A hold that ended, as a capture or a void does. */
async function endHold(gala: Gala, paddleId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ id: string }>(
      "update holds set status = 'voided' where paddle_id = $1 and status = 'authorized' returning id",
      [paddleId],
    );
    await appendEventLog(
      client,
      rows.map((row) => ({ eventId: gala.eventId, paddleId, type: "hold" as const, payload: { holdId: row.id, status: "voided" } })),
    );
    await client.query("commit");
  } finally {
    client.release();
  }
}

async function perform(gala: Gala, action: Action): Promise<void> {
  const paddle = "who" in action ? gala.paddles[action.who] : undefined;
  const target = "lot" in action ? gala.lots[action.lot] : undefined;
  switch (action.kind) {
    case "bid": {
      if (!paddle || !target) return;
      const { next, raise } = await nextMinimum(target.id);
      await placeBid(paddle.id, target.id, next + action.extraRaises * raise, "guest", { pool });
      return;
    }
    case "max": {
      if (!paddle || !target) return;
      const { next, raise } = await nextMinimum(target.id);
      await setMaxBid(paddle.id, target.id, next + action.extraRaises * raise, { pool });
      return;
    }
    case "removeMax":
      if (paddle && target) await removeLimit(paddle.id, target.id, { pool });
      return;
    case "glimLimit": {
      if (!paddle || !target) return;
      const { next, raise } = await nextMinimum(target.id);
      await createLimits(paddle.id, [{ lotId: target.id, maxCents: next + action.extraRaises * raise }], { pool });
      return;
    }
    case "heart":
      if (paddle && target) {
        await setFavorite(
          { eventId: gala.eventId, paddleId: paddle.id, lotId: target.id, lotNumber: target.number, isFavorite: action.on },
          pool,
        );
      }
      return;
    case "raiseHold":
      if (paddle) await raiseHold(gala, paddle.id, action.cents);
      return;
    case "endHold":
      if (paddle) await endHold(gala, paddle.id);
      return;
    case "closeLot":
      if (target) {
        await expireLot(pool, target.id);
        await closeDueLots(undefined, { pool });
      }
      return;
    case "closeAll":
      await closeEvent(gala.eventId, { pool });
      return;
  }
}

const viewerRows = (gala: Gala, after: string, through: string): Promise<StreamEvent[]> =>
  readVisibleRows(pool, {
    eventId: gala.eventId,
    viewer: { paddleId: gala.paddles[0]?.id ?? null, isOrganizer: false },
    after,
    through,
    limit: 5_000,
  });

/**
 * Two views are the same to a guest. A forced close stores the moment of its update and the row the
 * start of its transaction, which pages only ever show to the minute.
 */
const toTheMinute = (at: number) => Math.round(at / (60 * SECONDS));

function comparableCatalog(view: CatalogView) {
  return {
    ...view,
    serverNow: 0,
    event: { ...view.event, closesAt: toTheMinute(view.event.closesAt) },
    lots: view.lots.map((item) => ({ ...item, closesAt: toTheMinute(item.closesAt) })),
  };
}

function comparableLot(view: LotDetailView) {
  return {
    ...view,
    serverNow: 0,
    event: { ...view.event, closesAt: toTheMinute(view.event.closesAt) },
    lot: { ...view.lot, closesAt: toTheMinute(view.lot.closesAt) },
  };
}

async function expectFoldEqualsFreshRead(target: Gala, reads: { position: string; catalog: NonNullable<Awaited<ReturnType<typeof getCatalogSeed>>>; lot: NonNullable<Awaited<ReturnType<typeof getLotDetailSeed>>> }) {
  const query = { slug: target.slug, paddleNumber: target.paddles[0]?.number ?? null };
  const through = await latestPosition(pool, target.eventId);
  const rows = await viewerRows(target, reads.position, through);

  const freshCatalog = await getCatalogSeed({ ...query, category: null }, source);
  const freshLot = await getLotDetailSeed({ ...query, lotNumber: target.lots[0]?.number ?? 0 }, source);
  if (!freshCatalog || !freshLot) throw new Error("the gala is gone");

  // Order aside: the page keeps its tiles in place; a fresh read ranks them.
  const sortLots = <View extends ReturnType<typeof comparableCatalog>>(view: View) => ({
    ...view,
    lots: [...view.lots].sort((a, b) => a.number - b.number),
  });
  const seed = { ...reads.catalog, streamPosition: reads.position };
  expect(sortLots(comparableCatalog(buildCatalogView(foldStreamRows(seed, rows))))).toEqual(
    sortLots(comparableCatalog(buildCatalogView(freshCatalog))),
  );
  const lotSeed = { ...reads.lot, streamPosition: reads.position };
  expect(comparableLot(buildLotDetailView(foldStreamRows(lotSeed, rows)))).toEqual(comparableLot(buildLotDetailView(freshLot)));
}

describe("folding the stream over a page's rows", () => {
  it(
    "lands where a fresh read does, for any sequence of actions, with rows replayed over the read",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArbitrary, { maxLength: 8 }),
          fc.array(actionArbitrary, { maxLength: 8 }),
          fc.array(actionArbitrary, { minLength: 1, maxLength: 16 }),
          async (beforePosition, betweenPositionAndRead, afterRead) => {
            const target = await gala();
            for (const action of beforePosition) await perform(target, action);

            // A page reads its position first: what lands before its rows are read shows up twice.
            const position = await latestPosition(pool, target.eventId);
            for (const action of betweenPositionAndRead) await perform(target, action);
            const query = { slug: target.slug, paddleNumber: target.paddles[0]?.number ?? null };
            const catalog = await getCatalogSeed({ ...query, category: null }, source);
            const lot = await getLotDetailSeed({ ...query, lotNumber: target.lots[0]?.number ?? 0 }, source);
            if (!catalog || !lot) throw new Error("the gala is gone");

            for (const action of afterRead) await perform(target, action);
            await expectFoldEqualsFreshRead(target, { position, catalog, lot });
          },
        ),
        { numRuns: RUNS },
      );
    },
    120_000,
  );

  it("follows a plan Glim bids on, and a skip, as a fresh read does", async () => {
    const database = { pool, db };
    const made = await createGala(pool);
    await heart(pool, made.jamie, made.lots.wine);
    const target: Gala = {
      eventId: made.eventId,
      slug: await slugOf(pool, made.eventId),
      paddles: [
        { id: made.jamie, number: 142 },
        { id: made.rival, number: 88 },
        { id: made.other, number: 90 },
      ],
      lots: [
        { id: made.lots.chef, number: 7 },
        { id: made.lots.wine, number: 9 },
        { id: made.lots.spa, number: 12 },
      ],
    };
    const position = await latestPosition(pool, target.eventId);
    const query = { slug: target.slug, paddleNumber: 142 };
    const catalog = await getCatalogSeed({ ...query, category: null }, source);
    const lot = await getLotDetailSeed({ ...query, lotNumber: 7 }, source);
    if (!catalog || !lot) throw new Error("the gala is gone");
    expect(buildCatalogView(catalog).lots.find((item) => item.number === 9)?.offerGlimWatch).toBe(true);

    const { confirmed } = await startBidding(database, made.jamie);
    await expectFoldEqualsFreshRead(target, { position, catalog, lot });
    const through = await viewerRows(target, position, await latestPosition(pool, target.eventId));
    expect(through.some((row) => row.type === "glim")).toBe(true);

    // A rival runs Glim's limit out, Jamie's own limit answers on the way.
    await perform(target, { kind: "bid", who: 1, lot: 0, extraRaises: 0 });
    await perform(target, { kind: "bid", who: 1, lot: 0, extraRaises: 10 });
    await expectFoldEqualsFreshRead(target, { position, catalog, lot });

    const skipped = await skipLot({ paddleId: made.jamie, lotId: made.lots.spa, pool });
    expect(skipped.ok).toBe(true);
    expect(confirmed.ok).toBe(true);
    await expectFoldEqualsFreshRead(target, { position, catalog, lot });
  });
});

describe("the page's own read", () => {
  it("reads the close the event really had, not its schedule, on the guest pages", async () => {
    const target = await gala();
    const query = { slug: target.slug, paddleNumber: 142, category: null };
    const before = await getCatalogSeed(query, source);
    await closeEvent(target.eventId, { pool });
    const after = await getCatalogSeed(query, source);
    const { rows } = await pool.query<{ closed_at: Date }>("select closed_at from events where id = $1", [target.eventId]);

    expect(Math.floor(after?.event.closesAt ?? 0)).toBe(rows[0]?.closed_at.getTime());
    expect(after?.event.closesAt).toBeLessThan(before?.event.closesAt ?? 0);
  });

  it("reads its position before its rows, so a page with no rows after it is simply current", async () => {
    const target = await gala();
    await perform(target, { kind: "bid", who: 1, lot: 0, extraRaises: 0 });
    const query = { slug: target.slug, paddleNumber: 142, category: null };
    const seed = await getCatalogSeed(query, source);
    expect(seed?.streamPosition).toBe(await latestPosition(pool, target.eventId));
    expect(seed && foldStreamRows(seed, await viewerRows(target, seed.streamPosition, seed.streamPosition))).toBe(seed);
  });

  it("answers position 0 for an event with no rows, and for one that does not exist", async () => {
    const target = await gala();
    expect(await source.streamPosition?.(target.slug)).toBe("0");
    expect(await source.streamPosition?.("no-such-gala")).toBe("0");
  });

  it("names the hold in place, so the stream can tell it from an older one", async () => {
    const target = await gala();
    const paddleId = target.paddles[0]?.id ?? "";
    const { rows } = await pool.query<{ id: string }>("select id from holds where paddle_id = $1", [paddleId]);
    const paddle = await source.findPaddle(target.eventId, 142);
    expect(paddle).toMatchObject({ holdCents: 60_000, holdId: rows[0]?.id });
  });
});
