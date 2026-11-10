/**
 * Getting in, for the home and join forms' Server Actions (./actions.ts): the same work as
 * POST /api/demo and POST /api/events/[slug]/join, for a form the browser posts itself. Before the
 * page hydrates, or with scripts off, the browser sends the form natively and the server answers
 * with the session cookie and a redirect, so a press never reloads the page and loses what was typed.
 *
 * Framework-free: the caller passes the request's headers, the session it read, and a cookie setter,
 * so this runs in tests on Postgres.
 */
import { ApiError } from "@/server/api/errors";
import { clientRateLimitKey, enforceRateLimit } from "@/server/api/rate-limit";
import { startDemoGala } from "@/server/demo/start";
import { backHrefFor } from "@/server/paypal/window-page";
import type { CreatedSession, Session } from "@/server/sessions";
import { joinEvent } from "@/server/sessions/join";

import { DEMO_GUEST_NAME, type EntryFormState } from "./entry-state";

/** As POST /api/events/[slug]/join: a whole table behind one venue's address has to fit. */
const JOINS_PER_CLIENT = { limit: 60, windowSeconds: 3_600 };

export interface EntryRequest {
  headers: Headers;
  /** Sets the session cookie on the answer (sessionCookieHeader's attributes). */
  setSession(created: CreatedSession): void;
}

export type EntryResult = { kind: "in"; href: string } | { kind: "refused"; state: EntryFormState };

const UNEXPECTED = "Something went wrong. Please try again.";

/** clientRateLimitKey reads the client's address from the headers alone. */
function asRequest(headers: Headers): Request {
  return new Request("http://fairhold.internal/", { headers });
}

async function refusing(firstName: string, work: () => Promise<string>): Promise<EntryResult> {
  try {
    return { kind: "in", href: await work() };
  } catch (error) {
    if (error instanceof ApiError) return { kind: "refused", state: { error: error.message, firstName, href: null } };
    console.error("[entry] failed:", error);
    return { kind: "refused", state: { error: UNEXPECTED, firstName, href: null } };
  }
}

/** Home's "Start a demo gala": a new gala, with this browser as paddle 142 and its organizer. */
export function enterDemo(request: EntryRequest, timeZone: string | null): Promise<EntryResult> {
  return refusing("", async () => {
    const demo = await startDemoGala({
      firstName: DEMO_GUEST_NAME,
      timeZone,
      clientKey: clientRateLimitKey(asRequest(request.headers), "demo"),
    });
    request.setSession(demo.created);
    return `/e/${encodeURIComponent(demo.slug)}`;
  });
}

/** 16b's "Get my paddle": the next paddle of this event, then `next` or the lots. */
export function enterEvent(
  request: EntryRequest,
  input: { slug: string; firstName: string; next: string | null; session: Session | null },
): Promise<EntryResult> {
  return refusing(input.firstName, async () => {
    if (!input.session?.paddleId) {
      await enforceRateLimit(clientRateLimitKey(asRequest(request.headers), "join"), JOINS_PER_CLIENT);
    }
    const joined = await joinEvent({ slug: input.slug, firstName: input.firstName, session: input.session });
    if (joined.created) request.setSession(joined.created);
    return backHrefFor(input.next, input.slug);
  });
}
