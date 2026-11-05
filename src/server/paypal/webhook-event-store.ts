/** Storage for verified PayPal webhook events, one row per PayPal event id. */
import { sql } from "drizzle-orm";

import { getDb, type Database } from "@/server/db/client";

import type { WebhookEvent } from "./webhooks";

export interface WebhookEventStore {
  /** "duplicate" when PayPal delivered this event id before (it retries up to 25 times). */
  insertOnce(event: WebhookEvent): Promise<"stored" | "duplicate">;
}

export function createPostgresWebhookEventStore(db?: Database): WebhookEventStore {
  return {
    async insertOnce(event) {
      const result = await (db ?? getDb()).execute(sql`
        insert into paypal_webhook_events
          (paypal_event_id, event_type, resource_type, resource_id, verified, payload, received_at)
        values
          (${event.eventId}, ${event.eventType}, ${event.resourceType}, ${event.resourceId}, true,
           ${JSON.stringify(event.payload)}::jsonb, now())
        on conflict (paypal_event_id) do nothing
        returning paypal_event_id
      `);
      return result.rows.length > 0 ? "stored" : "duplicate";
    },
  };
}
