import { FIXTURE_SLUG } from "@/server/demo/template";
import { getDevelopmentSwitches } from "@/server/lib/env";

/**
 * The instant Glim reads as now on this event: the database's (undefined), except that a frozen clock
 * reproduces a moment of the seeded fixture, whose lots close at set evening times. A demo gala on the
 * same server runs on real time. Production ignores the switch.
 */
export function frozenNow(eventSlug: string | undefined): Date | undefined {
  const frozenAt = getDevelopmentSwitches().freezeClockAt;
  return frozenAt === null || eventSlug !== FIXTURE_SLUG ? undefined : new Date(frozenAt);
}
