/**
 * Reads screen 10's rows (paddle-view.ts builds the view). 08's rows come from the guest read
 * source, so a frozen clock and the UI fixture work as they do on 08; Glim's plan and feed and a
 * pending raise come from Postgres.
 */
import { planCardsArmAutopilot } from "@/server/chat/switch";
import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { getDevelopmentSwitches } from "@/server/lib/env";

import { NO_GLIM_RECORDS, type PaddleFeedEntry, type PaddleGlimRecords, type PaddleSeed } from "./paddle-view";
import { getGuestReadSource } from "./source";
import type { GuestReadSource } from "./types";

export { buildPaddleView, type PaddleSeed, type PaddleView } from "./paddle-view";

/** A PayPal window for a raise counts as open this long; an abandoned one stays pending for good. */
export const RAISE_WINDOW_MS = 10 * 60 * 1_000;

/** Glim's lines on 10. Rejected proposals, nudges and raise offers are not things Glim did. */
const FEED_KINDS = [
  "plan_started",
  "bid",
  "raise",
  "limit_reached",
  "lot_won",
  "lot_lost",
  "paused",
  "resumed",
  "plan_edited",
  "autopilot_changed",
] as const;

/** Enough for a whole evening; older lines drop off the bottom. */
const FEED_ROWS = 60;

interface FeedRow {
  id: string;
  kind: (typeof FEED_KINDS)[number];
  message: string;
  chip: "winning" | "closed" | "none";
  amount_cents: number | null;
  short_title: string | null;
  at: number;
  first_plan: boolean;
}

const upper = (text: string) => text.toLocaleUpperCase("en-US");

export function feedLabel(row: Pick<FeedRow, "kind" | "short_title" | "first_plan">): string {
  switch (row.kind) {
    case "plan_started":
      return row.first_plan ? "PLAN STARTED" : "PLAN UPDATED";
    case "plan_edited":
      return "PLAN UPDATED";
    case "paused":
      return "PAUSED";
    case "resumed":
      return "RESUMED";
    default:
      return row.short_title ? upper(row.short_title) : "YOUR PLAN";
  }
}

function feedEntry(row: FeedRow): PaddleFeedEntry {
  const chip: PaddleFeedEntry["chip"] =
    row.chip === "winning" && row.amount_cents !== null
      ? { kind: "winning", amountCents: row.amount_cents }
      : row.chip === "closed"
        ? { kind: "closed" }
        : null;
  return { id: row.id, at: row.at, label: feedLabel(row), line: row.message, chip };
}

/** Glim's plan, duty and feed for one paddle. */
export async function readPaddleGlim(db: Queryable, paddleId: string): Promise<PaddleGlimRecords> {
  const [plans, feed] = await Promise.all([
    db.query<{ id: string; status: string; paused_at_ms: number | null; armed: boolean; on_duty_ms: number | null }>(
      `select g.id, g.status::text as status,
         (extract(epoch from g.paused_at) * 1000)::float8 as paused_at_ms,
         g.mandate is not null as armed,
         (select (extract(epoch from min(first.confirmed_at)) * 1000)::float8
            from glim_plans first where first.paddle_id = g.paddle_id and first.confirmed_at is not null) as on_duty_ms
       from glim_plans g
       where g.paddle_id = $1 and g.status in ('active', 'paused')
       limit 1`,
      [paddleId],
    ),
    db.query<FeedRow>(
      `select a.id::text as id, a.kind::text as kind, a.message, a.chip::text as chip,
         -- An autopilot row's chip is the bid it placed (detail.chipCents, design/21 V4), not its new maximum.
         coalesce((a.detail->>'chipCents')::integer, a.amount_cents)::integer as amount_cents,
         l.short_title, (extract(epoch from a.created_at) * 1000)::float8 as at,
         a.kind = 'plan_started' and not exists (
           select 1 from glim_actions earlier
           where earlier.paddle_id = a.paddle_id and earlier.kind = 'plan_started' and earlier.decision = 'executed'
             and (earlier.created_at, earlier.id) < (a.created_at, a.id)
         ) as first_plan
       from glim_actions a
       left join lots l on l.id = a.lot_id
       where a.paddle_id = $1 and a.decision = 'executed' and a.kind::text = any($2::text[])
       order by a.created_at desc, a.id desc
       limit ${FEED_ROWS}`,
      [paddleId, FEED_KINDS],
    ),
  ]);

  const running = plans.rows[0];
  let plan: PaddleGlimRecords["plan"] = null;
  if (running) {
    const { rows: items } = await db.query<{ lot_id: string; max_cents: number; status: string }>(
      "select lot_id::text as lot_id, max_cents::integer as max_cents, status::text as status from glim_plan_items where plan_id = $1",
      [running.id],
    );
    plan = {
      status: running.status === "paused" ? "paused" : "active",
      pausedAt: running.paused_at_ms,
      armed: running.armed,
      items: items.map((item) => ({ lotId: item.lot_id, maxCents: item.max_cents, skipped: item.status === "skipped" })),
    };
  }
  return {
    plan,
    onDutySince: running?.on_duty_ms ?? null,
    autopilotOn: planCardsArmAutopilot(),
    feed: feed.rows.map(feedEntry),
  };
}

/**
 * A raise waiting in a PayPal window: a hold newer than the paddle's authorized one, still pending.
 * An older pending hold is a first try that never reached PayPal (its window was blocked, then the
 * guest tried again and approved), not a raise.
 */
export async function readRaisePending(db: Queryable, paddleId: string): Promise<boolean> {
  const { rows } = await db.query<{ pending: boolean }>(
    `select exists (
       select 1 from holds pending
       where pending.paddle_id = $1 and pending.status = 'pending_approval'
         and pending.created_at > now() - ($2::int * interval '1 millisecond')
         and exists (
           select 1 from holds held
           where held.paddle_id = $1 and held.status = 'authorized' and held.created_at < pending.created_at
         )
     ) as pending`,
    [paddleId, RAISE_WINDOW_MS],
  );
  return rows[0]?.pending === true;
}

export interface PaddleQuery {
  slug: string;
  paddleNumber: number;
}

/**
 * 10's rows, and the stream position they include every row up to (read first, as 08 does). Null
 * when the event or the paddle is unknown.
 */
export async function getPaddleSeed(query: PaddleQuery, source?: GuestReadSource): Promise<PaddleSeed | null> {
  const reads = source ?? (await getGuestReadSource());
  const streamPosition = (await reads.streamPosition?.(query.slug)) ?? "0";
  const event = await reads.findEvent(query.slug);
  if (!event) return null;
  const [now, lots, paddle] = await Promise.all([
    reads.currentTime(),
    reads.listLots(event.id),
    reads.findPaddle(event.id, query.paddleNumber),
  ]);
  if (!paddle) return null;
  const viewerLots = await reads.listViewerLots(event.id, paddle.id);

  // UI_FIXTURE renders without a database: no plan, no feed.
  const fixture = getDevelopmentSwitches().uiFixture !== null;
  const [glim, raisePending] = fixture
    ? [NO_GLIM_RECORDS, false]
    : await Promise.all([readPaddleGlim(getPool(), paddle.id), readRaisePending(getPool(), paddle.id)]);

  return { streamPosition, now, event, lots, paddle, viewerLots, glim, raisePending };
}
