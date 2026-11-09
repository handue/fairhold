/**
 * The line over each PayPal window frame, "Riverside Shelter Gala · Paddle 142", and the hold's
 * amount for frame 2. Read by the hold's id (an unguessable uuid in the window's URL), or for frame
 * 1 by the event and this browser's session. Nothing here decides anything: a failed read only
 * leaves the line out.
 */
import { getPool } from "@/server/db/client";
import { getSession } from "@/server/sessions";

export interface WindowContext {
  eventName: string;
  paddleNumber: number;
  amountCents: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function windowContextForHold(holdId: string): Promise<WindowContext | null> {
  if (!UUID.test(holdId)) return null;
  try {
    const { rows } = await getPool().query<{ name: string; number: number; amount_cents: number }>(
      `select e.name, p.number, h.amount_cents
       from holds h join paddles p on p.id = h.paddle_id join events e on e.id = h.event_id
       where h.id = $1`,
      [holdId],
    );
    const row = rows[0];
    return row ? { eventName: row.name, paddleNumber: row.number, amountCents: row.amount_cents } : null;
  } catch (error) {
    console.error("[paypal window] could not read the hold's event:", error);
    return null;
  }
}

/** Frame 1 has no hold yet: the event and this browser's paddle there. */
export async function windowContextForEvent(
  slug: string,
  request: Request,
): Promise<Pick<WindowContext, "eventName" | "paddleNumber"> | null> {
  try {
    const session = await getSession(slug, request);
    if (!session?.paddleNumber) return null;
    const { rows } = await getPool().query<{ name: string }>("select name from events where id = $1", [session.eventId]);
    return rows[0] ? { eventName: rows[0].name, paddleNumber: session.paddleNumber } : null;
  } catch (error) {
    console.error("[paypal window] could not read the event:", error);
    return null;
  }
}
