/**
 * Starting a demo gala from the home page: createDemoEvent behind the two demo limits, and a session
 * for its creator, who holds paddle 142 and organizer rights over this event alone.
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { enforceRateLimit } from "@/server/api/rate-limit";
import { getPool } from "@/server/db/client";
import { createSession, type CreatedSession } from "@/server/sessions";
import { parseFirstName } from "@/server/sessions/join";

import { createDemoEvent } from "./createDemoEvent";

export const DEMO_LIMITS = {
  /** New demos per client address per hour. */
  startsPerClientPerHour: 5,
  /** Demos still taking bids at once, across everyone. */
  active: 25,
} as const;

/** Advisory-lock key (see engine/locks.ts): one start at a time, so two cannot pass the count together. */
const DEMO_START_LOCK = { namespace: 0x4648_0004, key: 1 } as const;
const CAPACITY_RETRY_SECONDS = 300;

export interface StartDemoInput {
  /** As typed on the home page. */
  firstName: string;
  /** The browser's IANA time zone, if it sent one. */
  timeZone?: string | null;
  /** From clientRateLimitKey; null means no per-client limit applies. */
  clientKey: string | null;
  /**
   * The gala this one takes over from (Reset demo). It no longer counts toward the running demos, and
   * `end` runs in this demo's own transaction, so a refused start leaves the old gala as it was and
   * only one of two presses can end it.
   */
  replaces?: { eventId: string; end: (client: pg.PoolClient) => Promise<void> };
}

export interface StartedDemo {
  slug: string;
  paddleNumber: number;
  firstName: string;
  /** To set on the response with attachSessionCookie. */
  created: CreatedSession;
}

/**
 * Both limits are checked inside the demo's own transaction, so a refused start leaves nothing
 * behind: a client turned away at capacity keeps its slot in the per-client count.
 */
export async function startDemoGala(input: StartDemoInput, pool: pg.Pool = getPool()): Promise<StartedDemo> {
  const firstName = parseFirstName(input.firstName);
  const demo = await createDemoEvent(
    {
      creatorFirstName: firstName,
      timeZone: input.timeZone,
      guard: async (client) => {
        await client.query("select pg_advisory_xact_lock($1, $2)", [DEMO_START_LOCK.namespace, DEMO_START_LOCK.key]);
        await input.replaces?.end(client);
        // A closed demo waiting for its 6-hour cleanup costs only rows, so it does not count. Under
        // next dev there is no limit: repeated end-to-end runs share one local database for 25 minutes.
        const { rows } = await client.query<{ active: number }>(
          "select count(*)::int as active from events where is_demo and status = 'live' and closes_at > now() and id is distinct from $1",
          [input.replaces?.eventId ?? null],
        );
        if (process.env.NODE_ENV !== "development" && (rows[0]?.active ?? 0) >= DEMO_LIMITS.active) {
          throw new ApiError(
            503,
            "demo_capacity",
            "Too many demo galas are running right now. Please try again in a few minutes.",
            { retryAfterSeconds: CAPACITY_RETRY_SECONDS },
            { "retry-after": String(CAPACITY_RETRY_SECONDS) },
          );
        }
        await enforceRateLimit(
          input.clientKey,
          { limit: DEMO_LIMITS.startsPerClientPerHour, windowSeconds: 3_600 },
          client,
          "You’ve started several demo galas in the last hour. Please try again later.",
        );
      },
    },
    pool,
  );
  const created = await createSession(
    { eventId: demo.event.id, paddleId: demo.creator.paddleId, isOrganizer: true, organizerName: demo.creator.firstName },
    pool,
  );
  return { slug: demo.event.slug, paddleNumber: demo.creator.paddleNumber, firstName: demo.creator.firstName, created };
}
