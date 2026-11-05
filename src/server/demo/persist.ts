/**
 * Writes an EventPlan with direct inserts, inside the caller's transaction. Like the engine's
 * store, it speaks the scope map's column names in SQL and generates ids here, so one plan is
 * written in a fixed order without reading anything back: events, paddles, holds, lots, photos,
 * favorites, Glim plans, plan items, limits, Glim actions, bids.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { EventPlan } from "./plan";

type Queryable = Pick<pg.ClientBase, "query">;

export interface PersistedEvent {
  eventId: string;
  paddleIds: ReadonlyMap<number, string>;
  lotIds: ReadonlyMap<number, string>;
}

// Postgres accepts at most 65,535 parameters per statement.
const MAX_PARAMETERS = 30_000;

async function insertRows(
  db: Queryable,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): Promise<void> {
  const perStatement = Math.max(1, Math.floor(MAX_PARAMETERS / columns.length));
  for (let start = 0; start < rows.length; start += perStatement) {
    const chunk = rows.slice(start, start + perStatement);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      if (row.length !== columns.length) {
        throw new Error(`${table}: a row has ${row.length} values for ${columns.length} columns`);
      }
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });
    await db.query(`insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}`, values);
  }
}

function lookup<K>(ids: ReadonlyMap<K, string>, key: K, what: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`The plan refers to ${what} ${String(key)}, which it does not contain`);
  return id;
}

function nullableLookup<K>(ids: ReadonlyMap<K, string>, key: K | null, what: string): string | null {
  return key === null ? null : lookup(ids, key, what);
}

const json = (value: unknown) => JSON.stringify(value);

export async function insertEventPlan(db: Queryable, plan: EventPlan): Promise<PersistedEvent> {
  const eventId = randomUUID();
  const paddleIds = new Map(plan.paddles.map((paddle) => [paddle.number, randomUUID()]));
  const lotIds = new Map(plan.lots.map((lot) => [lot.number, randomUUID()]));
  const paddle = (number: number) => lookup(paddleIds, number, "paddle");
  const lot = (number: number) => lookup(lotIds, number, "lot");
  const pairKey = (paddleNumber: number, lotNumber: number) => `${paddleNumber}:${lotNumber}`;

  const { event } = plan;
  await insertRows(
    db,
    "events",
    [
      "id", "slug", "name", "charity_name", "charity_ein", "charity_is_501c3", "timezone", "currency",
      "opens_at", "closes_at", "status", "soft_descriptor", "hold_presets_cents", "hold_min_cents",
      "hold_max_cents", "pickup_note", "join_url", "is_demo", "demo_expires_at", "template_key", "closed_at",
    ],
    [[
      eventId, event.slug, event.name, event.charityName, event.charityEin, event.charityIs501c3, event.timeZone,
      event.currency, event.opensAt, event.closesAt, event.status, event.softDescriptor, event.holdPresetsCents,
      event.holdMinCents, event.holdMaxCents, event.pickupNote, event.joinUrl, event.isDemo, event.demoExpiresAt,
      event.templateKey, event.closedAt,
    ]],
  );

  await insertRows(
    db,
    "paddles",
    ["id", "event_id", "number", "first_name", "last_initial", "is_simulated", "bot_profile", "created_at"],
    plan.paddles.map((row) => [
      paddle(row.number), eventId, row.number, row.firstName, row.lastInitial, row.isSimulated,
      row.botProfile === null ? null : json(row.botProfile), row.createdAt,
    ]),
  );

  await insertRows(
    db,
    "holds",
    ["id", "event_id", "paddle_id", "kind", "amount_cents", "status", "authorized_at", "honor_until", "expires_at"],
    plan.holds.map((hold) => [
      randomUUID(), eventId, paddle(hold.paddleNumber), hold.kind, hold.amountCents, hold.status,
      hold.authorizedAt, hold.honorUntil, hold.expiresAt,
    ]),
  );

  await insertRows(
    db,
    "lots",
    [
      "id", "event_id", "number", "short_title", "title", "category", "donor_name", "description",
      "estimated_value_cents", "value_basis", "starting_bid_cents", "min_raise_cents", "closes_at", "status",
      "current_bid_cents", "bid_count", "high_paddle_id", "high_bid_source", "winning_paddle_id", "winning_cents",
      "closed_at",
    ],
    plan.lots.map((row) => [
      lot(row.number), eventId, row.number, row.shortTitle, row.title, row.category, row.donorName, row.description,
      row.estimatedValueCents, row.valueBasis, row.startingBidCents, row.minRaiseCents, row.closesAt, row.status,
      row.currentBidCents, row.bidCount, nullableLookup(paddleIds, row.highPaddleNumber, "paddle"), row.highBidSource,
      nullableLookup(paddleIds, row.winningPaddleNumber, "paddle"), row.winningCents, row.closedAt,
    ]),
  );

  // lots.cover_photo_id and lot_photos.lot_id point at each other, so covers are linked after both exist.
  const photoRows = plan.lotPhotos.map((photo) => ({ id: randomUUID(), photo }));
  await insertRows(
    db,
    "lot_photos",
    ["id", "lot_id", "position", "is_cover", "kind", "illustration_key", "alt"],
    photoRows.map(({ id, photo }) => [
      id, lot(photo.lotNumber), photo.position, photo.isCover, photo.kind, photo.illustrationKey, photo.alt,
    ]),
  );
  for (const { id, photo } of photoRows) {
    if (photo.isCover) await db.query("update lots set cover_photo_id = $1 where id = $2", [id, lot(photo.lotNumber)]);
  }

  await insertRows(
    db,
    "favorites",
    ["paddle_id", "lot_id", "created_at"],
    plan.favorites.map((favorite) => [paddle(favorite.paddleNumber), lot(favorite.lotNumber), favorite.createdAt]),
  );

  const planIds = new Map(plan.glimPlans.map((glimPlan) => [glimPlan.paddleNumber, randomUUID()]));
  await insertRows(
    db,
    "glim_plans",
    ["id", "paddle_id", "status", "budget_cents", "proposal", "model", "confirmed_at", "ended_at", "version"],
    // Seeded plans were never proposed by a model, so model stays null.
    plan.glimPlans.map((row) => [
      lookup(planIds, row.paddleNumber, "Glim plan of paddle"), paddle(row.paddleNumber), row.status, row.budgetCents,
      json(row.proposal), null, row.confirmedAt, row.endedAt, 1,
    ]),
  );

  const itemIds = new Map(plan.glimPlanItems.map((item) => [pairKey(item.paddleNumber, item.lotNumber), randomUUID()]));
  await insertRows(
    db,
    "glim_plan_items",
    ["id", "plan_id", "lot_id", "priority", "max_cents", "status"],
    plan.glimPlanItems.map((item) => [
      lookup(itemIds, pairKey(item.paddleNumber, item.lotNumber), "plan item"),
      lookup(planIds, item.paddleNumber, "Glim plan of paddle"), lot(item.lotNumber), item.priority, item.maxCents,
      item.status,
    ]),
  );

  const limitIds = new Map(plan.bidLimits.map((limit) => [pairKey(limit.paddleNumber, limit.lotNumber), randomUUID()]));
  await insertRows(
    db,
    "bid_limits",
    [
      "id", "paddle_id", "lot_id", "max_cents", "owner", "plan_item_id", "active", "exhausted_at", "ended_at",
      "created_at",
    ],
    plan.bidLimits.map((limit) => {
      const key = pairKey(limit.paddleNumber, limit.lotNumber);
      return [
        lookup(limitIds, key, "limit"), paddle(limit.paddleNumber), lot(limit.lotNumber), limit.maxCents, limit.owner,
        itemIds.get(key) ?? null, limit.active, limit.exhaustedAt, limit.endedAt, limit.createdAt,
      ];
    }),
  );

  const actionIds = new Map(plan.glimActions.map((action) => [action.key, randomUUID()]));
  await insertRows(
    db,
    "glim_actions",
    [
      "id", "paddle_id", "plan_id", "lot_id", "kind", "amount_cents", "limit_cents", "hold_cents_at_time", "decision",
      "message", "chip", "created_at",
    ],
    plan.glimActions.map((action) => [
      lookup(actionIds, action.key, "Glim action"), paddle(action.paddleNumber),
      planIds.get(action.paddleNumber) ?? null,
      action.lotNumber === null ? null : lot(action.lotNumber), action.kind, action.amountCents, action.limitCents,
      action.holdCentsAtTime, action.decision, action.message, action.chip, action.createdAt,
    ]),
  );

  const bidIds = new Map(plan.bids.map((bid) => [bid.key, randomUUID()]));
  await insertRows(
    db,
    "bids",
    ["id", "lot_id", "paddle_id", "amount_cents", "source", "limit_id", "glim_action_id", "created_at"],
    plan.bids.map((bid) => [
      lookup(bidIds, bid.key, "bid"), lot(bid.lotNumber), paddle(bid.paddleNumber), bid.amountCents, bid.source,
      bid.source === "glim" ? (limitIds.get(pairKey(bid.paddleNumber, bid.lotNumber)) ?? null) : null,
      nullableLookup(actionIds, bid.glimActionKey, "Glim action"), bid.createdAt,
    ]),
  );

  // Raises name the rival bid they answered; bids reference actions, so this link comes last.
  for (const action of plan.glimActions) {
    if (action.triggerBidKey === null) continue;
    await db.query("update glim_actions set trigger_bid_id = $1 where id = $2", [
      lookup(bidIds, action.triggerBidKey, "bid"),
      lookup(actionIds, action.key, "Glim action"),
    ]);
  }

  return { eventId, paddleIds, lotIds };
}
