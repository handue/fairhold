/**
 * Sessions: a browser's identity in one event. No passwords: an httpOnly, SameSite=Lax cookie holds
 * a random token and sessions.token_hash its keyed hash. Organizer rights live on the session, so
 * they cover its event only.
 *
 * Route handlers read the cookie from the Request and set it on the Response; server components
 * pass `await cookies()`. Neither needs anything else from Next, so all of this runs in tests.
 */
import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { ApiError } from "@/server/api/errors";
import { getServerEnv } from "@/server/lib/env";

import {
  hashSessionToken,
  newSessionToken,
  readCookieHeader,
  sessionCookieHeader,
  sessionCookieName,
} from "./cookie";

export { sessionCookieName } from "./cookie";

export interface Session {
  id: string;
  eventId: string;
  eventSlug: string;
  /** Null for an organizer without a paddle; demo creators and guests always have one. */
  paddleId: string | null;
  paddleNumber: number | null;
  firstName: string | null;
  /** Rights over this session's event, and no other. */
  isOrganizer: boolean;
  organizerName: string | null;
}

export type PaddleSession = Session & { paddleId: string; paddleNumber: number; firstName: string };

/** Where a session cookie can be read from: a route handler's Request, or `await cookies()`. */
export type CookieSource = Request | { get(name: string): { value: string } | undefined };

export interface CreateSessionInput {
  eventId: string;
  paddleId: string | null;
  isOrganizer?: boolean;
  organizerName?: string | null;
}

export interface CreatedSession {
  session: Session;
  /** The only copy of the raw token: it goes in the cookie and nowhere else. */
  token: string;
  maxAgeSeconds: number;
}

/** A session unused for this long stops working. */
const IDLE_DAYS = 7;
const MAX_AGE_SECONDS = IDLE_DAYS * 24 * 60 * 60;
/** A demo's cookie lives as long as the demo, so abandoned demos do not pile up in the browser. */
const MIN_DEMO_MAX_AGE_SECONDS = 60 * 60;
/** last_seen_at is written at most this often. */
const TOUCH_AFTER_SECONDS = 60;

interface SessionRow {
  id: string;
  event_id: string;
  event_slug: string;
  paddle_id: string | null;
  paddle_number: number | null;
  first_name: string | null;
  is_organizer: boolean;
  organizer_name: string | null;
}

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  eventId: row.event_id,
  eventSlug: row.event_slug,
  paddleId: row.paddle_id,
  paddleNumber: row.paddle_number,
  firstName: row.first_name,
  isOrganizer: row.is_organizer,
  organizerName: row.organizer_name,
});

const tokenHash = (token: string) => hashSessionToken(token, getServerEnv().SESSION_SECRET);

/**
 * Opens a session and returns its token. Pass a transaction's client to open it together with the
 * paddle. In a route handler, finish with attachSessionCookie(response, created).
 */
export async function createSession(input: CreateSessionInput, db: Queryable = getPool()): Promise<CreatedSession> {
  const token = newSessionToken();
  const { rows } = await db.query<SessionRow & { max_age_seconds: number }>(
    `with inserted as (
       insert into sessions (token_hash, event_id, paddle_id, is_organizer, organizer_name)
       values ($1, $2, $3, $4, $5)
       returning id, event_id, paddle_id, is_organizer, organizer_name
     )
     select s.id, s.event_id, e.slug as event_slug, s.paddle_id, p.number as paddle_number, p.first_name,
       s.is_organizer, s.organizer_name,
       (case when e.is_demo and e.demo_expires_at is not null
          then greatest(ceil(extract(epoch from e.demo_expires_at - now())), $6::int)
          else $7::int end)::int as max_age_seconds
     from inserted s
     join events e on e.id = s.event_id
     left join paddles p on p.id = s.paddle_id`,
    [
      tokenHash(token),
      input.eventId,
      input.paddleId,
      input.isOrganizer ?? false,
      input.organizerName ?? null,
      MIN_DEMO_MAX_AGE_SECONDS,
      MAX_AGE_SECONDS,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("The session was not created: its event does not exist");
  return { session: toSession(row), token, maxAgeSeconds: row.max_age_seconds };
}

/** Sets the session cookie on a response. */
export function attachSessionCookie(response: Response, created: CreatedSession): Response {
  const secure = process.env.NODE_ENV === "production";
  response.headers.append(
    "set-cookie",
    sessionCookieHeader(created.session.eventSlug, created.token, created.maxAgeSeconds, secure),
  );
  return response;
}

function readToken(slug: string, source: CookieSource): string | null {
  const name = sessionCookieName(slug);
  if ("headers" in source) return readCookieHeader(source.headers.get("cookie"), name);
  return source.get(name)?.value ?? null;
}

/**
 * This browser's session in the event `slug`, or null. The cookie is named after the slug and the
 * row must belong to that event too, so a session never answers for another event.
 */
export async function getSession(slug: string, source: CookieSource, db: Queryable = getPool()): Promise<Session | null> {
  const token = readToken(slug, source);
  if (!token) return null;

  const { rows } = await db.query<SessionRow & { stale: boolean }>(
    `select s.id, s.event_id, e.slug as event_slug, s.paddle_id, p.number as paddle_number, p.first_name,
       s.is_organizer, s.organizer_name,
       s.last_seen_at < now() - make_interval(secs => $3::int) as stale
     from sessions s
     join events e on e.id = s.event_id
     left join paddles p on p.id = s.paddle_id
     where s.token_hash = $1 and e.slug = $2 and s.last_seen_at > now() - make_interval(days => $4::int)`,
    [tokenHash(token), slug, TOUCH_AFTER_SECONDS, IDLE_DAYS],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.stale) await db.query("update sessions set last_seen_at = now() where id = $1", [row.id]);
  return toSession(row);
}

const notJoined = () => new ApiError(401, "not_joined", "Join this event to continue.");

/** The session, or a 401 with code not_joined. */
export async function requireSession(slug: string, source: CookieSource, db?: Queryable): Promise<Session> {
  const session = await getSession(slug, source, db);
  if (!session) throw notJoined();
  return session;
}

/** A session with a paddle: what bidding, holds and Glim need. Otherwise a 401 with code not_joined. */
export async function requirePaddle(slug: string, source: CookieSource, db?: Queryable): Promise<PaddleSession> {
  const session = await requireSession(slug, source, db);
  if (session.paddleId === null || session.paddleNumber === null || session.firstName === null) throw notJoined();
  return session as PaddleSession;
}

/** This event's organizer: a 401 for no session, a 403 with code organizer_only for anyone else. */
export async function requireOrganizer(slug: string, source: CookieSource, db?: Queryable): Promise<Session> {
  const session = await requireSession(slug, source, db);
  if (!session.isOrganizer) {
    throw new ApiError(403, "organizer_only", "Only this event’s organizer can do that.");
  }
  return session;
}
