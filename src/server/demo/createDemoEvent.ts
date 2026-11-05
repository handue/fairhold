/**
 * Creating events from the Riverside template: a private demo gala for whoever presses
 * "Start a demo gala", and the approved fixture that visual checks and the seed script use.
 */
import type pg from "pg";

import { getPool } from "@/server/db/client";

import { buildDemoEventPlan } from "./demoPlan";
import { buildFixtureEventPlan } from "./fixturePlan";
import { demoSlug, normalizeFirstName, resolveTimeZone } from "./identity";
import { assertWithinHolds } from "./invariant";
import { insertEventPlan, type PersistedEvent } from "./persist";
import type { EventPlan, EventStatus } from "./plan";
import { JAMIE } from "./roster";
import { FIXTURE_MOMENTS, type FixtureMoment } from "./storyClock";
import { CREATOR_PADDLE_NUMBER, FIXTURE_SLUG, RIVERSIDE_EVENT } from "./template";

export interface SeededEvent {
  id: string;
  slug: string;
  name: string;
  timeZone: string;
  status: EventStatus;
  opensAt: Date;
  closesAt: Date;
  isDemo: boolean;
  demoExpiresAt: Date | null;
}

export interface CreateDemoEventInput {
  /** As typed on the home page. */
  creatorFirstName: string;
  creatorLastInitial?: string | null;
  /** The browser's IANA time zone; anything unrecognized falls back to the gala's own. */
  timeZone?: string | null;
  /** Defaults to the database clock, which the engine also closes lots by. */
  now?: Date;
}

export interface CreatedDemoEvent {
  event: SeededEvent;
  /**
   * Paddle 142, with no hold yet. The creator is this event's organizer: the caller records
   * that on the session it opens (sessions.is_organizer), which scopes it to this event alone.
   */
  creator: { paddleId: string; paddleNumber: number; firstName: string; isOrganizer: true };
}

export async function createDemoEvent(
  input: CreateDemoEventInput,
  pool: pg.Pool = getPool(),
): Promise<CreatedDemoEvent> {
  const firstName = normalizeFirstName(input.creatorFirstName);
  const lastInitial = normalizeInitial(input.creatorLastInitial);
  const timeZone = resolveTimeZone(input.timeZone, RIVERSIDE_EVENT.timeZone);

  return inTransaction(pool, async (client) => {
    const now = input.now ?? (await databaseNow(client));
    const plan = buildDemoEventPlan({ now, slug: demoSlug(), timeZone, creator: { firstName, lastInitial } });
    const persisted = await writePlan(client, plan);
    return {
      event: seededEvent(plan, persisted),
      creator: {
        paddleId: paddleId(persisted, CREATOR_PADDLE_NUMBER),
        paddleNumber: CREATOR_PADDLE_NUMBER,
        firstName,
        isOrganizer: true,
      },
    };
  });
}

export interface CreateFixtureEventInput {
  /** Which approved moment to reproduce; the catalog moment (08 and 05) by default. */
  moment?: FixtureMoment;
  slug?: string;
}

export interface CreatedFixtureEvent {
  event: SeededEvent;
  moment: FixtureMoment;
  /** The instant the fixture shows: freeze the app clock here to render it. */
  at: Date;
  jamie: { paddleId: string; paddleNumber: number };
}

/** Replaces any event with the same slug, so running it twice leaves one fixture. */
export async function createFixtureEvent(
  { moment = "catalog", slug = FIXTURE_SLUG }: CreateFixtureEventInput = {},
  pool: pg.Pool = getPool(),
): Promise<CreatedFixtureEvent> {
  const plan = buildFixtureEventPlan({ moment, slug });
  return inTransaction(pool, async (client) => {
    // Every table hangs off events with on delete cascade, so one delete clears the old copy.
    await client.query("delete from events where slug = $1", [slug]);
    const persisted = await writePlan(client, plan);
    return {
      event: seededEvent(plan, persisted),
      moment,
      at: FIXTURE_MOMENTS[moment],
      jamie: { paddleId: paddleId(persisted, JAMIE.number), paddleNumber: JAMIE.number },
    };
  });
}

async function writePlan(client: pg.PoolClient, plan: EventPlan): Promise<PersistedEvent> {
  assertWithinHolds(plan);
  return insertEventPlan(client, plan);
}

function seededEvent(plan: EventPlan, persisted: PersistedEvent): SeededEvent {
  const { event } = plan;
  return {
    id: persisted.eventId,
    slug: event.slug,
    name: event.name,
    timeZone: event.timeZone,
    status: event.status,
    opensAt: event.opensAt,
    closesAt: event.closesAt,
    isDemo: event.isDemo,
    demoExpiresAt: event.demoExpiresAt,
  };
}

function paddleId(persisted: PersistedEvent, number: number): string {
  const id = persisted.paddleIds.get(number);
  if (!id) throw new Error(`Paddle ${number} was not created`);
  return id;
}

function normalizeInitial(input: string | null | undefined): string | null {
  const letter = input?.trim().charAt(0).toUpperCase();
  return letter ? letter : null;
}

async function databaseNow(client: pg.PoolClient): Promise<Date> {
  const { rows } = await client.query<{ now: Date }>("select now() as now");
  const now = rows[0]?.now;
  if (!now) throw new Error("select now() returned no row");
  return now;
}

async function inTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    // A connection that cannot even roll back is discarded instead of returned to the pool.
    broken = !(await client.query("rollback").then(
      () => true,
      () => false,
    ));
    throw error;
  } finally {
    client.release(broken);
  }
}
