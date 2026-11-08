/**
 * What screen 09 renders: the nav's event and viewer from the guest read source, and the event's
 * hold rules and the paddle's commitments, which only this screen needs.
 */
import { getPool } from "@/server/db/client";
import { RIVERSIDE_EVENT } from "@/server/demo/template";
import { eventHasEnded, getBiddingPower } from "@/server/engine";
import { getDevelopmentSwitches } from "@/server/lib/env";
import { toEventSummary } from "@/server/queries/event";
import { getGuestReadSource } from "@/server/queries/source";
import type { EventSummary, GuestReadSource, LotRecord, ViewerSummary } from "@/server/queries/types";
import { indexViewerLots, summarizeViewer } from "@/server/queries/viewer";

import { resolveHoldLimits, type HoldLimits } from "./rules";

export interface PowerView {
  event: EventSummary;
  /** Null for a visitor with no paddle here; the page sends them to join. */
  viewer: ViewerSummary | null;
  limits: HoldLimits;
  currentHoldCents: number | null;
  committedCents: number;
  biddingEnded: boolean;
  /** The lot the explainer's example is about, or null when the event has none to name. */
  exampleLot: string | null;
}

export interface PowerQuery {
  slug: string;
  paddleNumber: number | null;
}

/** Null when the event is unknown. */
export async function getPowerView(query: PowerQuery, source?: GuestReadSource): Promise<PowerView | null> {
  const reads = source ?? (await getGuestReadSource());
  const event = await reads.findEvent(query.slug);
  if (!event) return null;

  const [lots, paddle] = await Promise.all([
    reads.listLots(event.id),
    query.paddleNumber === null ? null : reads.findPaddle(event.id, query.paddleNumber),
  ]);
  const viewerLots = paddle ? await reads.listViewerLots(event.id, paddle.id) : [];
  const { limits, committedCents, pastClose } = await readHoldRules(event.id, paddle?.id ?? null);

  return {
    event: toEventSummary(event),
    viewer: paddle ? summarizeViewer(paddle, lots, indexViewerLots(viewerLots)) : null,
    limits,
    currentHoldCents: paddle?.holdCents ?? null,
    committedCents,
    biddingEnded: eventHasEnded(event.status) || pastClose,
    exampleLot: exampleLotName(lots),
  };
}

interface HoldRules {
  limits: HoldLimits;
  committedCents: number;
  /**
   * By the database clock, the one createHold refuses by, and never the pages' frozen clock
   * (FREEZE_CLOCK_AT), so this page and the button agree.
   */
  pastClose: boolean;
}

async function readHoldRules(eventId: string, paddleId: string | null): Promise<HoldRules> {
  // UI_FIXTURE renders without a database, and its event is the template.
  if (getDevelopmentSwitches().uiFixture !== null) {
    return {
      limits: resolveHoldLimits({
        presetsCents: RIVERSIDE_EVENT.holdPresetsCents,
        minCents: RIVERSIDE_EVENT.holdMinCents,
        maxCents: RIVERSIDE_EVENT.holdMaxCents,
      }),
      committedCents: 0,
      pastClose: false,
    };
  }
  const pool = getPool();
  const [{ rows }, power] = await Promise.all([
    pool.query<{ presets: number[] | null; min: number | null; max: number | null; past_close: boolean }>(
      `select hold_presets_cents as presets, hold_min_cents as min, hold_max_cents as max,
         clock_timestamp() >= closes_at as past_close
       from events where id = $1`,
      [eventId],
    ),
    paddleId === null ? null : getBiddingPower([paddleId], pool),
  ]);
  const row = rows[0];
  return {
    limits: resolveHoldLimits({
      presetsCents: row?.presets ?? null,
      minCents: row?.min ?? null,
      maxCents: row?.max ?? null,
    }),
    committedCents: (paddleId && power?.get(paddleId)?.committedCents) || 0,
    pastClose: row?.past_close ?? false,
  };
}

const PARTY_SIZE_SUFFIX = /\s+for\s+(?:two|three|four|five|six|seven|eight|nine|ten|\d+)$/i;

/**
 * The approved example is the Chef's Table Dinner: the event's first open dining lot, named without
 * its party size. A closed lot would make a poor example, so it moves on to the next one.
 */
export function exampleLotName(lots: readonly Pick<LotRecord, "category" | "status" | "title">[]): string | null {
  const open = lots.filter((lot) => lot.status === "open");
  const lot = open.find((candidate) => candidate.category === "dining") ?? open[0];
  return lot ? lot.title.replace(PARTY_SIZE_SUFFIX, "") : null;
}
