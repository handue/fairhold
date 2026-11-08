/**
 * The guest pages' viewer comes from the session. Two browsers in one demo see their own paddles,
 * and in production ?paddle= no longer lets anyone see anyone else's bidding power.
 */
import { cookies } from "next/headers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSession, sessionCookieName } from "@/server/sessions";
import { createDemoEvent, createFixtureEvent } from "@/server/demo/createDemoEvent";
import { FIXTURE_SLUG } from "@/server/demo/template";
import { joinEvent } from "@/server/sessions/join";
import { getCatalogView } from "@/server/queries/catalog";
import { getLotDetailView } from "@/server/queries/lot";
import { resolveViewer } from "@/server/queries/viewer";

import { getTestDatabase } from "../../helpers/database";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const { pool } = getTestDatabase();

/** Makes `cookies()` answer as a browser holding these cookies. */
function browserHolds(jar: Record<string, string> = {}) {
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

beforeEach(() => browserHolds());

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(cookies).mockReset();
});

async function demoWithTwoBrowsers() {
  const { event, creator } = await createDemoEvent({ creatorFirstName: "Sam" }, pool);
  const creatorSession = await createSession({ eventId: event.id, paddleId: creator.paddleId, isOrganizer: true }, pool);
  const guest = await joinEvent({ slug: event.slug, firstName: "Kai", session: null }, pool);
  const name = sessionCookieName(event.slug);
  return {
    slug: event.slug,
    guestNumber: guest.paddleNumber,
    creatorJar: { [name]: creatorSession.token },
    guestJar: { [name]: guest.created?.token ?? "" },
  };
}

describe("resolveViewer", () => {
  it("gives each browser its own paddle and rights", async () => {
    const demo = await demoWithTwoBrowsers();

    browserHolds(demo.creatorJar);
    await expect(resolveViewer(demo.slug, null)).resolves.toMatchObject({ paddleNumber: 142, isOrganizer: true, linkPaddle: null });
    const creatorView = await getCatalogView({ slug: demo.slug, paddleNumber: 142, category: null });
    expect(creatorView?.viewer).toMatchObject({ paddleNumber: 142, firstName: "Sam", holdCents: null });

    browserHolds(demo.guestJar);
    await expect(resolveViewer(demo.slug, null)).resolves.toMatchObject({ paddleNumber: demo.guestNumber, isOrganizer: false });
    const guestView = await getCatalogView({ slug: demo.slug, paddleNumber: demo.guestNumber, category: null });
    expect(guestView?.viewer).toMatchObject({ paddleNumber: demo.guestNumber, firstName: "Kai" });
  });

  it("leaves a browser with no session a visitor, in every environment, except on the fixture outside production", async () => {
    const demo = await demoWithTwoBrowsers();
    await expect(resolveViewer(demo.slug, null)).resolves.toMatchObject({ paddleNumber: null, session: null, isOrganizer: false });

    await createFixtureEvent({}, pool);
    await expect(resolveViewer(FIXTURE_SLUG, null)).resolves.toMatchObject({ paddleNumber: 142, isOrganizer: true });

    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveViewer(demo.slug, null)).resolves.toMatchObject({ paddleNumber: null });
    await expect(resolveViewer(FIXTURE_SLUG, null)).resolves.toMatchObject({ paddleNumber: null, isOrganizer: false });
  });

  it("honors ?paddle= outside production only", async () => {
    const demo = await demoWithTwoBrowsers();
    browserHolds(demo.guestJar);

    await expect(resolveViewer(demo.slug, 142)).resolves.toMatchObject({ paddleNumber: 142, linkPaddle: 142 });

    vi.stubEnv("NODE_ENV", "production");
    await expect(resolveViewer(demo.slug, 142)).resolves.toMatchObject({ paddleNumber: demo.guestNumber, linkPaddle: null });
  });

  it("reads no session with UI_FIXTURE on, so the design mode needs no database", async () => {
    vi.stubEnv("UI_FIXTURE", "riverside");
    browserHolds({ [sessionCookieName(FIXTURE_SLUG)]: "any-token" });
    await expect(resolveViewer(FIXTURE_SLUG, null)).resolves.toMatchObject({ paddleNumber: 142, session: null });
    expect(cookies).not.toHaveBeenCalled();
  });
});

describe("the read models for a visitor", () => {
  it("still show the event, with no viewer", async () => {
    const { slug } = await demoWithTwoBrowsers();
    const catalog = await getCatalogView({ slug, paddleNumber: null, category: null });
    expect(catalog?.viewer).toBeNull();
    expect(catalog?.lots.every((lot) => lot.viewerStatus === "none")).toBe(true);
    const lot = await getLotDetailView({ slug, lotNumber: 7, paddleNumber: null });
    expect(lot?.viewer).toBeNull();
    expect(lot?.lot.viewerStatus).toBe("none");
  });
});
