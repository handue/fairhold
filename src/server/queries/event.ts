import type { EventRecord, EventSummary } from "./types";

export function toEventSummary(event: EventRecord): EventSummary {
  return {
    slug: event.slug,
    name: event.name,
    charityName: event.charityName,
    timeZone: event.timeZone,
    status: event.status,
    opensAt: event.opensAt,
    closesAt: event.closesAt,
  };
}
