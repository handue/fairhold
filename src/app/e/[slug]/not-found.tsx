import { EventPageNotFound } from "@/ui/entry/NotFound";

/**
 * notFound() on a page of an event. When the event itself is gone, the layout's demo slot covers
 * this with design/16c; what shows here is a missing page of an event that is still there.
 */
export default function EventNotFound() {
  return <EventPageNotFound />;
}
