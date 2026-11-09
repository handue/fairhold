import { describe, expect, it } from "vitest";

import type { Session } from "@/server/sessions";

import { chooseViewer } from "./viewer";

const FIXTURE = "riverside-shelter-gala";
const DEMO = "gala-abc";

const session = (overrides: Partial<Session> = {}): Session => ({
  id: "session-1",
  eventId: "event-1",
  eventSlug: DEMO,
  paddleId: "paddle-188",
  paddleNumber: 188,
  firstName: "Sam",
  isOrganizer: false,
  organizerName: null,
  ...overrides,
});

describe("chooseViewer in production", () => {
  const production = true;

  it("lets the session decide", () => {
    expect(chooseViewer({ production, slug: DEMO, paddleParam: null, session: session() })).toMatchObject({
      paddleNumber: 188,
      linkPaddle: null,
      isOrganizer: false,
    });
  });

  it("ignores ?paddle= with or without a session", () => {
    expect(chooseViewer({ production, slug: DEMO, paddleParam: 142, session: session() })).toMatchObject({
      paddleNumber: 188,
      linkPaddle: null,
    });
    expect(chooseViewer({ production, slug: DEMO, paddleParam: 142, session: null })).toMatchObject({
      paddleNumber: null,
      linkPaddle: null,
    });
  });

  it("has no default viewer, even on the fixture", () => {
    expect(chooseViewer({ production, slug: FIXTURE, paddleParam: null, session: null })).toEqual({
      paddleNumber: null,
      linkPaddle: null,
      session: null,
      isOrganizer: false,
    });
  });

  it("takes organizer rights only from the session", () => {
    const organizer = session({ isOrganizer: true, organizerName: "Sam" });
    expect(chooseViewer({ production, slug: DEMO, paddleParam: null, session: organizer }).isOrganizer).toBe(true);
    expect(chooseViewer({ production, slug: FIXTURE, paddleParam: null, session: null }).isOrganizer).toBe(false);
  });
});

describe("chooseViewer outside production", () => {
  const production = false;

  it("lets ?paddle= pick the viewer and carries it along links", () => {
    expect(chooseViewer({ production, slug: FIXTURE, paddleParam: 88, session: null })).toMatchObject({
      paddleNumber: 88,
      linkPaddle: 88,
    });
    expect(chooseViewer({ production, slug: DEMO, paddleParam: 88, session: session() })).toMatchObject({
      paddleNumber: 88,
      linkPaddle: 88,
    });
  });

  it("uses the session over the fixture's default", () => {
    expect(chooseViewer({ production, slug: FIXTURE, paddleParam: null, session: session({ eventSlug: FIXTURE }) })).toMatchObject({
      paddleNumber: 188,
      isOrganizer: false,
    });
  });

  it("shows the fixture as approved with no session: Jamie, who also sees its control room", () => {
    expect(chooseViewer({ production, slug: FIXTURE, paddleParam: null, session: null })).toEqual({
      paddleNumber: 142,
      linkPaddle: null,
      session: null,
      isOrganizer: true,
    });
  });

  it("treats a browser with no session as a visitor on any other event", () => {
    expect(chooseViewer({ production, slug: DEMO, paddleParam: null, session: null })).toEqual({
      paddleNumber: null,
      linkPaddle: null,
      session: null,
      isOrganizer: false,
    });
  });
});
