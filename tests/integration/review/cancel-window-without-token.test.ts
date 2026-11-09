/**
 * Review finding (wave 2): /paypal/cancel checks the order token only when one is sent, and needs no
 * session. PayPal always appends the token. An organizer, which is anyone who started a demo, receives
 * every guest's hold ids on the stream, so a bare /paypal/cancel?hold=<id> cancels another guest's open
 * window. The guest can then approve at PayPal and get "This hold was canceled". Until the fix, this fails.
 */
import { describe, expect, it } from "vitest";

import { POST as holdRoute } from "@/app/api/holds/[slug]/route";
import { GET as pollRoute } from "@/app/api/stream/poll/route";
import { GET as cancelRoute } from "@/app/paypal/cancel/route";
import { createSession, sessionCookieName } from "@/server/api";
import { createDemoEvent } from "@/server/demo/createDemoEvent";
import type { HoldStreamPayload, StreamPollResponse } from "@/server/sse/types";
import { joinEvent } from "@/server/sessions/join";

import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";

const { pool } = getTestDatabase();
const ORIGIN = "https://fairhold.example";

describe("another guest's PayPal window", () => {
  it("cannot be canceled by someone who only knows the hold id", async () => {
    const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
    const organizer = await createSession(
      { eventId: event.id, paddleId: creator.paddleId, isOrganizer: true, organizerName: creator.firstName },
      pool,
    );
    const organizerCookie = `${sessionCookieName(event.slug)}=${organizer.token}`;
    const joined = await joinEvent({ slug: event.slug, firstName: "Kai", session: null }, pool);
    const guestCookie = `${sessionCookieName(event.slug)}=${joined.created?.token ?? ""}`;

    const opened = await holdRoute(postJson(`/api/holds/${event.slug}`, { amountCents: 50_000 }, { cookie: guestCookie }), {
      params: Promise.resolve({ slug: event.slug }),
    });
    expect(opened.status).toBe(201);

    // What the organizer's own stream tells it.
    const poll = await pollRoute(
      new Request(`${ORIGIN}/api/stream/poll?slug=${event.slug}&after=0`, { headers: { cookie: organizerCookie } }),
      undefined,
    );
    const { rows } = (await poll.json()) as StreamPollResponse;
    const row = rows.find((candidate) => candidate.type === "hold" && candidate.paddleId === joined.paddleId);
    const holdId = (row?.payload as HoldStreamPayload | undefined)?.holdId ?? "";
    expect(holdId).not.toBe("");

    await cancelRoute(new Request(`${ORIGIN}/paypal/cancel?hold=${holdId}`));

    const { rows: holds } = await pool.query<{ status: string }>("select status from holds where id = $1", [holdId]);
    expect(holds[0]?.status).toBe("pending_approval");
  });
});
