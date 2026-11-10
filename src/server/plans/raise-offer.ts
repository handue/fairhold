/**
 * The raise Glim prepared and the guest may still take (design/21 V3, docs/planning/glim-autopilot.md
 * §6.4). It is open while it is the newest autopilot action, younger than ten minutes, above the hold
 * in place, its lots still open, the plan it was prepared for still running (an edit that replaced
 * the plan ends it, since the guest may have taken its lot out) and bidding live, and the guest hasn't
 * said "Not now". The panel draws "This offer ended" otherwise, and the raise route only ever opens a
 * PayPal window for the amount stored on an open offer, never for an amount a browser sends.
 */
import type { Queryable } from "./db";
import { RAISE_PENDING_SECONDS } from "./apply";

/** The key "Not now" adds to the action's detail; the prepared action itself never changes otherwise. */
export const RAISE_DISMISSED_KEY = "dismissedAt";

export interface OpenRaiseOffer {
  actionId: string;
  /** The total bidding power to approve, from the stored action. */
  amountCents: number;
}

/** The paddle's open raise offer, or null when there is none. */
export async function loadOpenRaiseOffer(db: Queryable, paddleId: string): Promise<OpenRaiseOffer | null> {
  const { rows } = await db.query<{ id: string; amount_cents: number | null; open: boolean }>(
    `select a.id, a.amount_cents,
       (a.kind = 'autopilot_raise_prepared'
         and a.amount_cents is not null
         and not (coalesce(a.detail, '{}'::jsonb) ? $3)
         and a.created_at > now() - make_interval(secs => $2)
         and e.status = 'live'
         and exists (select 1 from glim_plans g where g.id = a.plan_id and g.paddle_id = a.paddle_id and g.status = 'active' and g.mandate is not null)
         and coalesce((select h.amount_cents from holds h where h.paddle_id = a.paddle_id and h.status = 'authorized'), 0) < a.amount_cents
         and jsonb_array_length(coalesce(a.detail->'pendingIntent', '[]'::jsonb)) > 0
         and not exists (
           select 1 from jsonb_array_elements(coalesce(a.detail->'pendingIntent', '[]'::jsonb)) intent
           left join lots l on l.event_id = e.id and l.number = (intent->>'lotNumber')::int
           where l.id is null or l.status <> 'open' or l.closes_at <= clock_timestamp()
         )) as open
     from glim_actions a
     join paddles p on p.id = a.paddle_id
     join events e on e.id = p.event_id
     where a.paddle_id = $1 and a.kind in ('autopilot_changed', 'autopilot_raise_prepared')
     order by a.created_at desc, a.id desc
     limit 1`,
    [paddleId, RAISE_PENDING_SECONDS, RAISE_DISMISSED_KEY],
  );
  const latest = rows[0];
  if (!latest?.open || latest.amount_cents === null) return null;
  return { actionId: latest.id, amountCents: latest.amount_cents };
}

/**
 * "Not now": the offer ends, so a raise the guest approves later on 09 is not taken as consent to
 * this one's move. True when it was open and is now ended; asking twice changes nothing.
 */
export async function dismissRaiseOffer(db: Queryable, paddleId: string, actionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update glim_actions
     set detail = coalesce(detail, '{}'::jsonb) || jsonb_build_object($3::text, to_jsonb(now()))
     where id = $2 and paddle_id = $1 and kind = 'autopilot_raise_prepared' and not (coalesce(detail, '{}'::jsonb) ? $3)`,
    [paddleId, actionId, RAISE_DISMISSED_KEY],
  );
  return (rowCount ?? 0) > 0;
}
