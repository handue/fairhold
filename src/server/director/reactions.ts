/**
 * Queues the rivals when a guest does something they answer: Start bidding, and a second lot bid on
 * by hand. It looks at the tables rather than a cursor, so it keeps no state to lose: a guest with
 * no job yet gets one, and a job's id comes from the guest (md5 of kind and paddle, in SQL), so a
 * restart or a second process cannot queue it twice. Only live demo galas are read, and each guest
 * gets one of each: confirming a changed plan later does not send the rivals again.
 */
import type pg from "pg";

import { parseMandate } from "@/server/glim/mandate";

import { insertJobs, type NewJob } from "./jobs";
import { destinationLotNumbers, rivalOutbidAt, rivalOverLimitAt, rivalUnderLimitAt } from "./rules";

const SCAN_LIMIT = 50;

type PlanRow = {
  under_job_id: string;
  over_job_id: string;
  event_id: string;
  paddle_id: string;
  paddle_number: number;
  confirmed_at: Date;
  mandate: unknown;
};

const STARTED_PLANS_SQL = `
  select md5('rival_under_limit:' || pd.id::text)::uuid as under_job_id,
    md5('rival_over_limit:' || pd.id::text)::uuid as over_job_id,
    e.id as event_id, pd.id as paddle_id, pd.number as paddle_number, p.confirmed_at, p.mandate
  from events e
  join paddles pd on pd.event_id = e.id and not pd.is_simulated
  join glim_plans p on p.paddle_id = pd.id and p.status = 'active' and p.confirmed_at is not null
  where e.is_demo and e.status = 'live'
    and not exists (select 1 from director_jobs j where j.id = md5('rival_under_limit:' || pd.id::text)::uuid)
  limit $1`;

type SecondLotRow = {
  job_id: string;
  event_id: string;
  paddle_id: string;
  paddle_number: number;
  lot_id: string;
  first_bid_at: Date;
};

// A guest's own "Max…" counts: it is their hand on the lot, though the engine places its bids.
const SECOND_MANUAL_LOTS_SQL = `
  select md5('rival_outbid:' || g.paddle_id::text)::uuid as job_id, g.event_id, g.paddle_id, g.paddle_number, g.lot_id,
    g.first_bid_at
  from (
    select pd.event_id, pd.id as paddle_id, pd.number as paddle_number, b.lot_id, min(b.created_at) as first_bid_at,
      row_number() over (partition by pd.id order by min(b.created_at), b.lot_id) as position
    from events e
    join paddles pd on pd.event_id = e.id and not pd.is_simulated
    join bids b on b.paddle_id = pd.id and b.source in ('guest', 'guest_max')
    where e.is_demo and e.status = 'live'
    group by pd.event_id, pd.id, pd.number, b.lot_id
  ) g
  where g.position = 2
    and not exists (select 1 from director_jobs j where j.id = md5('rival_outbid:' || g.paddle_id::text)::uuid)
  limit $1`;

async function plannedRivalJobs(pool: pg.Pool, plan: PlanRow): Promise<NewJob[]> {
  const { rows } = await pool.query<{ closes_at: Date }>(
    "select closes_at from lots where event_id = $1 and number = any($2) and status = 'open'",
    [plan.event_id, destinationLotNumbers(parseMandate(plan.mandate)?.lots)],
  );
  const underLimitAt = rivalUnderLimitAt(plan.confirmed_at, plan.paddle_number);
  const overLimitAt = rivalOverLimitAt({
    underLimitAt,
    destinationClosesAt: rows.map((row) => row.closes_at),
    paddleNumber: plan.paddle_number,
  });
  const payload = { guestPaddleId: plan.paddle_id };
  return [
    { id: plan.under_job_id, eventId: plan.event_id, kind: "rival_under_limit", runAt: underLimitAt, payload },
    { id: plan.over_job_id, eventId: plan.event_id, kind: "rival_over_limit", runAt: overLimitAt, payload },
  ];
}

/** Returns how many rival jobs it queued. Two small queries when there is nothing to do. */
export async function scheduleReactions(pool: pg.Pool): Promise<number> {
  const { rows: plans } = await pool.query<PlanRow>(STARTED_PLANS_SQL, [SCAN_LIMIT]);
  const { rows: secondLots } = await pool.query<SecondLotRow>(SECOND_MANUAL_LOTS_SQL, [SCAN_LIMIT]);
  const jobs: NewJob[] = secondLots.map((row) => ({
    id: row.job_id,
    eventId: row.event_id,
    kind: "rival_outbid",
    runAt: rivalOutbidAt(row.first_bid_at, row.paddle_number),
    payload: { guestPaddleId: row.paddle_id, lotId: row.lot_id },
  }));
  for (const plan of plans) jobs.push(...(await plannedRivalJobs(pool, plan)));
  return insertJobs(pool, jobs);
}
