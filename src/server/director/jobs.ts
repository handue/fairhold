/**
 * What goes on director_jobs: one job is one bid the director may place. Jobs carry no amounts a
 * rival could not recompute: each one decides its bid from the lot's state when it runs.
 */
import { z } from "zod";

import type { Queryable } from "@/server/db/transaction";

export const DIRECTOR_JOB_KINDS = ["bot_bid", "rival_under_limit", "rival_outbid", "rival_over_limit"] as const;
export type DirectorJobKind = (typeof DIRECTOR_JOB_KINDS)[number];

/** One simulated guest's bid at the lot's next minimum, up to what their bot profile allows. */
export const botBidPayload = z.object({
  paddleId: z.string(),
  paddleNumber: z.number().int(),
  lotId: z.string(),
  lotNumber: z.number().int(),
  maxCents: z.number().int().positive(),
});
export type BotBidPayload = z.infer<typeof botBidPayload>;

/** Glim's priority-1 lot is read when the job runs, from this guest's running plan. */
export const rivalOfPlanPayload = z.object({ guestPaddleId: z.string() });
export type RivalOfPlanPayload = z.infer<typeof rivalOfPlanPayload>;

export const rivalOutbidPayload = z.object({ guestPaddleId: z.string(), lotId: z.string() });
export type RivalOutbidPayload = z.infer<typeof rivalOutbidPayload>;

export type NewJob = { id?: string; eventId: string; runAt: Date } & (
  | { kind: "bot_bid"; payload: BotBidPayload }
  | { kind: "rival_under_limit" | "rival_over_limit"; payload: RivalOfPlanPayload }
  | { kind: "rival_outbid"; payload: RivalOutbidPayload }
);

/**
 * Inserts jobs in one statement. A job with an id that already exists is left alone, which is what
 * makes queueing a reaction safe to repeat: scheduleReactions derives each reaction's id from the
 * guest, so a restart or a second process cannot queue it twice. Returns how many were new.
 */
export async function insertJobs(db: Queryable, jobs: readonly NewJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const { rowCount } = await db.query(
    `insert into director_jobs (id, event_id, kind, payload, run_at)
     select coalesce(job.id, gen_random_uuid()), job.event_id, job.kind, job.payload, job.run_at
     from unnest($1::uuid[], $2::uuid[], $3::text[], $4::jsonb[], $5::timestamptz[])
       as job(id, event_id, kind, payload, run_at)
     on conflict (id) do nothing`,
    [
      jobs.map((job) => job.id ?? null),
      jobs.map((job) => job.eventId),
      jobs.map((job) => job.kind),
      jobs.map((job) => JSON.stringify(job.payload)),
      jobs.map((job) => job.runAt.toISOString()),
    ],
  );
  return rowCount ?? 0;
}

/** Ends what the director still had planned for an event. Returns how many jobs it dropped. */
export async function cancelQueuedJobs(db: Queryable, eventId: string): Promise<number> {
  const { rowCount } = await db.query(
    "update director_jobs set status = 'canceled', completed_at = clock_timestamp() where event_id = $1 and status = 'queued'",
    [eventId],
  );
  return rowCount ?? 0;
}
