/**
 * Joining an event: a first name is all it takes. One browser keeps one paddle per event, however
 * often it joins.
 */
import type pg from "pg";

import { ApiError } from "@/server/api/errors";
import { getPool } from "@/server/db/client";
import { holdsNul } from "@/server/db/text";
import { withTransaction } from "@/server/db/transaction";
import { normalizeFirstName } from "@/server/demo/identity";
import { eventHasEnded } from "@/server/engine/rules";
import type { EventStatus } from "@/server/engine/types";

import { createSession, type CreatedSession, type Session } from ".";

/** Advisory-lock namespace (first key) for handing out paddle numbers; see engine/locks.ts. */
const PADDLE_NUMBER_LOCK_CLASS = 0x4648_0003;
/** An event with no paddles yet starts at 101; otherwise the number after its highest. */
const FIRST_PADDLE_BASE = 100;

export interface JoinInput {
  slug: string;
  /** As typed; checked with parseFirstName. */
  firstName: string;
  /** This browser's session in the event, if it has one. */
  session: Session | null;
}

export interface JoinedEvent {
  slug: string;
  paddleId: string;
  paddleNumber: number;
  firstName: string;
  /** A new session, to set on the response. Null when the browser already had a session here. */
  created: CreatedSession | null;
}

/**
 * Whether guests may join and hold on this event. In production only a demo gala takes them: nothing
 * can close, charge or release a seeded event there, because it has no organizer and the sweep only
 * retires demos, so a real hold on it would stay held until PayPal's 29 days run out.
 */
export function takesGuests(event: { isDemo: boolean }): boolean {
  return event.isDemo || process.env.NODE_ENV !== "production";
}

export const seededEventRefusal = () =>
  new ApiError(403, "event_view_only", "This event is for viewing. Start your own demo gala to bid.");

/** The name for storing, or a 400 a guest can read. */
export function parseFirstName(input: string): string {
  try {
    return normalizeFirstName(input);
  } catch {
    throw new ApiError(400, "invalid_first_name", "Enter a first name of up to 40 characters.");
  }
}

export async function joinEvent(input: JoinInput, pool: pg.Pool = getPool()): Promise<JoinedEvent> {
  const { slug, session } = input;
  if (session?.paddleId && session.paddleNumber !== null && session.firstName !== null) {
    return { slug, paddleId: session.paddleId, paddleNumber: session.paddleNumber, firstName: session.firstName, created: null };
  }
  const firstName = parseFirstName(input.firstName);
  const notFound = () => new ApiError(404, "event_not_found", "We could not find this event.");
  if (holdsNul(slug)) throw notFound();

  return withTransaction(pool, async (client) => {
    const { rows: events } = await client.query<{ id: string; status: EventStatus; is_demo: boolean }>(
      "select id, status, is_demo from events where slug = $1",
      [slug],
    );
    const event = events[0];
    if (!event) throw notFound();
    if (!takesGuests({ isDemo: event.is_demo })) throw seededEventRefusal();
    if (eventHasEnded(event.status)) throw new ApiError(409, "event_closed", "Bidding has closed for this event.");

    // Held until commit, so the next join reads the number this one takes. A lock of its own, not
    // the event row: the engine locks that row, and joining must never wait on bidding or block it.
    await client.query("select pg_advisory_xact_lock($1, hashtext($2))", [PADDLE_NUMBER_LOCK_CLASS, event.id]);
    const { rows: paddles } = await client.query<{ id: string; number: number }>(
      `insert into paddles (event_id, number, first_name, is_simulated)
       select $1::uuid, coalesce(max(number), $3::int) + 1, $2::text, false from paddles where event_id = $1::uuid
       returning id, number`,
      [event.id, firstName, FIRST_PADDLE_BASE],
    );
    const paddle = paddles[0];
    if (!paddle) throw new Error("The paddle was not created");

    if (session) {
      // An organizer without a paddle yet: the cookie stays, and the session gains the paddle.
      await client.query("update sessions set paddle_id = $1 where id = $2", [paddle.id, session.id]);
      return { slug, paddleId: paddle.id, paddleNumber: paddle.number, firstName, created: null };
    }
    const created = await createSession({ eventId: event.id, paddleId: paddle.id }, client);
    return { slug, paddleId: paddle.id, paddleNumber: paddle.number, firstName, created };
  });
}
