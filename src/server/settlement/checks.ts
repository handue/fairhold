/**
 * The checks on 12 before charging. Two read only the database: every winner's total is within an
 * authorized hold, and every bid Glim placed stayed within its limit and the hold. The third asks
 * PayPal about each real hold: status CREATED and the expiry still ahead, reauthorizing first a hold
 * past its honor period on an event that is not a demo.
 */
import type { Queryable } from "@/server/db/transaction";
import { PaypalError } from "@/server/paypal/errors";

import { resolveDependencies, type SettlementDependencies } from "./dependencies";
import { bidderName } from "./names";
import { reauthorizeHold } from "./reauthorize";
import type { CheckKey, CheckProblem, SettlementCheck, SettlementChecks } from "./types";

/** At most this many PayPal reads at once. */
const READ_CONCURRENCY = 4;

interface PaddleName {
  paddle_number: number;
  first_name: string;
  last_initial: string | null;
}

const nameOf = (row: PaddleName) => bidderName(row.first_name, row.last_initial);

/** Every winner's total against the paddle's authorized hold. */
export async function checkWinnersWithinHolds(db: Queryable, eventId: string): Promise<SettlementCheck> {
  const { rows } = await db.query<PaddleName & { won_cents: number; hold_cents: number | null }>(
    `select p.number as paddle_number, p.first_name, p.last_initial, w.won_cents, h.amount_cents as hold_cents
     from (
       select winning_paddle_id as paddle_id, sum(winning_cents)::int as won_cents
       from lots
       where event_id = $1 and status = 'closed' and winning_paddle_id is not null
       group by winning_paddle_id
     ) w
     join paddles p on p.id = w.paddle_id
     left join holds h on h.paddle_id = w.paddle_id and h.status = 'authorized'
     order by p.number`,
    [eventId],
  );
  const problems = rows.flatMap((row): CheckProblem[] => {
    if (row.hold_cents === null) return [problem(row, "no_hold")];
    return row.won_cents > row.hold_cents ? [problem(row, "over_hold")] : [];
  });
  return decided("winners_within_holds", rows.length, problems);
}

/**
 * Every bid Glim placed, read back from the bids themselves rather than from Glim's own log: it was
 * placed under one of this paddle's limits on this lot, and at or below that limit and the hold in
 * place when it was placed. That is the largest authorization the paddle had by then, whatever
 * became of it since: a hold voided or expired later says nothing about the bid. The margin only
 * covers PayPal's clock, which authorized_at comes from, running ahead of the database's.
 *
 * A bid never changes, so a problem here never clears. Only a winner's counts as blocking, since
 * nobody else is about to be charged, and it must not stop the others (day2.md decision 41).
 */
export async function checkGlimWithinLimits(db: Queryable, eventId: string): Promise<SettlementCheck> {
  const { rows } = await db.query<PaddleName & { bids: number; code: string | null; won_cents: number }>(
    `select p.number as paddle_number, p.first_name, p.last_initial, count(*)::int as bids,
       max(case
         when bl.id is null or bl.paddle_id <> b.paddle_id or bl.lot_id <> b.lot_id then 'no_limit'
         when b.amount_cents > bl.max_cents then 'over_limit'
         when b.amount_cents > coalesce((
           select max(h.amount_cents) from holds h
           where h.paddle_id = b.paddle_id
             and h.status not in ('pending_approval', 'canceled', 'denied', 'failed')
             and (h.authorized_at is null or h.authorized_at <= b.created_at + interval '1 minute')
         ), 0) then 'over_hold'
       end) as code,
       coalesce((select sum(w.winning_cents)::int from lots w
                 where w.winning_paddle_id = p.id and w.status = 'closed'), 0) as won_cents
     from bids b
     join lots l on l.id = b.lot_id
     join paddles p on p.id = b.paddle_id
     left join bid_limits bl on bl.id = b.limit_id
     where l.event_id = $1 and b.source = 'glim'
     group by p.id, p.number, p.first_name, p.last_initial
     order by p.number`,
    [eventId],
  );
  const problems = rows.flatMap((row) => (row.code ? [problem(row, row.code, row.won_cents > 0)] : []));
  return decided(
    "glim_within_limits",
    rows.reduce((sum, row) => sum + row.bids, 0),
    problems,
  );
}

interface RealHoldRow extends PaddleName {
  id: string;
  paddle_id: string;
  amount_cents: number;
  original_authorization_id: string | null;
  current_authorization_id: string | null;
  authorized_at: Date | null;
  expires_at: Date | null;
  past_honor: boolean;
  is_demo: boolean;
  won_cents: number;
}

const REAL_HOLDS_SQL = `
  select h.id, h.paddle_id, h.amount_cents, h.original_authorization_id, h.current_authorization_id,
    h.authorized_at, h.expires_at, coalesce(h.honor_until <= clock_timestamp(), false) as past_honor,
    e.is_demo, p.number as paddle_number, p.first_name, p.last_initial,
    coalesce((select sum(l.winning_cents)::int from lots l
              where l.winning_paddle_id = h.paddle_id and l.status = 'closed'), 0) as won_cents
  from holds h
  join events e on e.id = h.event_id
  join paddles p on p.id = h.paddle_id
  where h.event_id = $1 and h.kind = 'paypal' and h.status = 'authorized'
  order by p.number`;

/** Asks PayPal about every real hold; a simulated hold has nothing to ask about. */
export async function checkHoldsValid(eventId: string, dependencies: SettlementDependencies): Promise<SettlementCheck> {
  const { rows } = await dependencies.pool.query<RealHoldRow>(REAL_HOLDS_SQL, [eventId]);
  const answers = await mapWithLimit(rows, READ_CONCURRENCY, (hold) => askPaypal(hold, dependencies));
  return decided(
    "holds_valid",
    rows.length,
    rows.flatMap((hold, index) => {
      const code = answers[index];
      return code ? [problem(hold, code, hold.won_cents > 0)] : [];
    }),
  );
}

/** Null when the hold can be charged; otherwise why not. */
async function askPaypal(hold: RealHoldRow, dependencies: SettlementDependencies): Promise<string | null> {
  if (!hold.current_authorization_id || !hold.original_authorization_id) return "no_authorization";
  const payments = dependencies.paymentsFor("paypal");
  let authorizationId = hold.current_authorization_id;
  try {
    // A hold that won nothing only gets voided, which does not need a fresh honor period.
    if (hold.past_honor && !hold.is_demo && hold.won_cents > 0) {
      const outcome = await reauthorizeHold(
        {
          id: hold.id,
          paddleId: hold.paddle_id,
          kind: "paypal",
          amountCents: hold.amount_cents,
          originalAuthorizationId: hold.original_authorization_id,
          authorizedAt: hold.authorized_at,
        },
        dependencies,
      );
      if (outcome.kind === "reauthorized") authorizationId = outcome.authorizationId;
    }
    const read = await payments.getAuthorization(authorizationId);
    if (read.status !== "CREATED") return read.status;
    const expiresAt = read.expiresAt ?? hold.expires_at;
    if (expiresAt && expiresAt.getTime() <= dependencies.now().getTime()) return "EXPIRED";
    if (read.amountCents < hold.won_cents) return "over_authorization";
    return null;
  } catch (error) {
    if (error instanceof PaypalError) return error.code;
    throw error;
  }
}

/** All three checks, with real PayPal reads. Nothing is charged here. */
export async function runSettlementChecks(
  eventId: string,
  overrides: Partial<SettlementDependencies> = {},
): Promise<SettlementChecks> {
  const dependencies = resolveDependencies(overrides);
  const [winners, glim, holds] = await Promise.all([
    checkWinnersWithinHolds(dependencies.pool, eventId),
    checkGlimWithinLimits(dependencies.pool, eventId),
    checkHoldsValid(eventId, dependencies),
  ]);
  return summarizeChecks([winners, glim, holds], dependencies.now().getTime());
}

export function summarizeChecks(checks: SettlementCheck[], ranAt: number | null): SettlementChecks {
  const failed = checks.some((check) => check.passed === false);
  const undecided = checks.some((check) => check.passed === null);
  return { passed: failed ? false : undecided ? null : true, ranAt, checks };
}

function problem(row: PaddleName, code: string, blocking = true): CheckProblem {
  return { paddleNumber: row.paddle_number, bidder: nameOf(row), code, blocking };
}

function decided(key: CheckKey, count: number, problems: CheckProblem[]): SettlementCheck {
  return { key, passed: !problems.some((item) => item.blocking), count, problems };
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
