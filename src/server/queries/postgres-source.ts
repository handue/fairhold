import { sql, type SQL } from "drizzle-orm";

import type { Database } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import { isOrWasBiddingPowerSql } from "@/server/holds/bidding-hold";

import type {
  BidRecord,
  EventRecord,
  GuestReadSource,
  LotPhotoRecord,
  LotRecord,
  PaddleNumberRecord,
  PaddleRecord,
  ViewerLotRecord,
} from "./types";

/** A timestamptz expression as epoch milliseconds; float8 so node-postgres returns a number. */
const epochMs = (timestamp: SQL) => sql`(extract(epoch from ${timestamp}) * 1000)::float8`;

/**
 * The guest reads in SQL over the scope map's data model. Each column is aliased to its field
 * name, so a row is its record. Ids are read as text and amounts as integers, so rows keep one
 * shape whether a column is a uuid, a serial or a bigint; times are read as epoch milliseconds,
 * because Drizzle's node-postgres driver hands raw timestamps back as strings.
 */
export function createPostgresGuestSource(db: Database): GuestReadSource {
  // node-postgres returns untyped rows; the aliases in each query are what make this cast hold.
  const select = async <Row>(query: SQL): Promise<Row[]> =>
    (await db.execute<Record<string, unknown>>(query)).rows as Row[];

  return {
    async currentTime() {
      const [row] = await select<{ now: number }>(sql`select ${epochMs(sql`now()`)} as "now"`);
      if (!row) throw new Error("select now() returned no row");
      return row.now;
    },

    async streamPosition(slug) {
      if (holdsNul(slug)) return "0";
      const [row] = await select<{ position: string }>(sql`
        select coalesce(max(log.id), 0)::text as "position"
        from event_log log
        join events e on e.id = log.event_id
        where e.slug = ${slug}
      `);
      return row?.position ?? "0";
    },

    async findEvent(slug) {
      if (holdsNul(slug)) return null;
      const [event] = await select<EventRecord>(sql`
        select
          id::text as "id",
          slug as "slug",
          name as "name",
          charity_name as "charityName",
          timezone as "timeZone",
          status::text as "status",
          ${epochMs(sql`opens_at`)} as "opensAt",
          ${epochMs(sql`coalesce(closed_at, closes_at)`)} as "closesAt"
        from events
        where slug = ${slug}
        limit 1
      `);
      return event ?? null;
    },

    async findPaddle(eventId, paddleNumber) {
      const [paddle] = await select<PaddleRecord>(sql`
        select
          p.id::text as "id",
          p.number::integer as "number",
          p.first_name as "firstName",
          hold.amount_cents::integer as "holdCents",
          hold.id::text as "holdId",
          held.amount_cents::integer as "heldCents"
        from paddles p
        left join lateral (
          select h.id, h.amount_cents
          from holds h
          where h.paddle_id = p.id and h.status = 'authorized'
          order by h.authorized_at desc nulls last
          limit 1
        ) hold on true
        left join lateral (
          select h.amount_cents
          from holds h
          where h.paddle_id = p.id and ${sql.raw(isOrWasBiddingPowerSql("h"))}
          order by (h.status = 'authorized') desc, h.authorized_at desc nulls last
          limit 1
        ) held on true
        where p.event_id = ${eventId} and p.number = ${paddleNumber}
        limit 1
      `);
      return paddle ?? null;
    },

    listLots(eventId) {
      return select<LotRecord>(sql`
        select
          l.id::text as "id",
          l.number::integer as "number",
          l.category::text as "category",
          l.title as "title",
          l.short_title as "shortTitle",
          l.donor_name as "donorName",
          l.estimated_value_cents::integer as "estimatedValueCents",
          l.starting_bid_cents::integer as "startingBidCents",
          l.min_raise_cents::integer as "minRaiseCents",
          l.current_bid_cents::integer as "currentBidCents",
          l.bid_count::integer as "bidCount",
          ${epochMs(sql`l.closes_at`)} as "closesAt",
          l.status::text as "status",
          l.high_paddle_id::text as "highPaddleId",
          l.winning_paddle_id::text as "winningPaddleId",
          l.winning_cents::integer as "winningCents",
          cover.illustration_key as "coverDrawing"
        from lots l
        left join lot_photos cover on cover.id = l.cover_photo_id
        where l.event_id = ${eventId} and l.status <> 'draft'
        order by l.number
      `);
    },

    listViewerLots(eventId, paddleId) {
      return select<ViewerLotRecord>(sql`
        select *
        from (
          select
            l.id::text as "lotId",
            exists (
              select 1 from bids b where b.lot_id = l.id and b.paddle_id = ${paddleId}
            ) as "hasBid",
            exists (
              select 1 from favorites f where f.lot_id = l.id and f.paddle_id = ${paddleId}
            ) as "isFavorite",
            exists (
              select 1
              from glim_plan_items item
              join glim_plans plan on plan.id = item.plan_id
              where item.lot_id = l.id
                and plan.paddle_id = ${paddleId}
                and plan.status in ('active', 'paused')
                and item.status <> 'skipped'
            ) as "inGlimPlan",
            (
              select bl.max_cents::integer
              from bid_limits bl
              where bl.lot_id = l.id and bl.paddle_id = ${paddleId} and bl.active
              limit 1
            ) as "limitCents"
          from lots l
          where l.event_id = ${eventId}
        ) relation
        where relation."hasBid"
          or relation."isFavorite"
          or relation."inGlimPlan"
          or relation."limitCents" is not null
      `);
    },

    listLotPhotos(lotId) {
      return select<LotPhotoRecord>(sql`
        select illustration_key as "drawing", alt as "alt"
        from lot_photos
        where lot_id = ${lotId}
        order by is_cover desc, position
      `);
    },

    listLeaderNumbers(eventId) {
      return select<PaddleNumberRecord>(sql`
        select distinct p.id::text as "paddleId", p.number::integer as "number"
        from lots l
        join paddles p on p.id = l.high_paddle_id or p.id = l.winning_paddle_id
        where l.event_id = ${eventId} and l.status <> 'draft'
      `);
    },

    listLatestBids(lotId, limit) {
      // Amounts strictly rise on a lot, so the highest bid is the newest. created_at is the start
      // of the bid's transaction, which can come before an earlier bid's when two waited on the
      // same lot lock, and bids placed by one action share it.
      return select<BidRecord>(sql`
        select
          b.paddle_id::text as "paddleId",
          p.number::integer as "paddleNumber",
          b.amount_cents::integer as "amountCents",
          ${epochMs(sql`b.created_at`)} as "createdAt"
        from bids b
        join paddles p on p.id = b.paddle_id
        where b.lot_id = ${lotId}
        order by b.amount_cents desc
        limit ${limit}
      `);
    },
  };
}
