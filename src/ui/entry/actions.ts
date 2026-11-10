"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { getSession, type CreatedSession } from "@/server/sessions";
import { sessionCookieName } from "@/server/sessions/cookie";

import { enterDemo, enterEvent, type EntryRequest } from "./enter";
import { HYDRATED_FIELD, type EntryFormState } from "./entry-state";

/**
 * The home and join forms post here (React's form actions), so they work before hydration and with
 * scripts off: the answer is the session cookie and a redirect (./enter.ts). Next checks that the
 * post came from this site.
 */
async function entryRequest(): Promise<EntryRequest> {
  const [requestHeaders, jar] = await Promise.all([headers(), cookies()]);
  return {
    headers: new Headers(requestHeaders),
    setSession(created: CreatedSession) {
      jar.set(sessionCookieName(created.session.eventSlug), created.token, {
        path: "/",
        maxAge: created.maxAgeSeconds,
        httpOnly: true,
        sameSite: "lax",
        // As sessionCookieHeader: Secure everywhere but a developer's own http://localhost.
        secure: process.env.NODE_ENV === "production",
      });
    },
  };
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

/** Before hydration the answer is a redirect; a hydrated form loads `href` itself (HYDRATED_FIELD). */
function arrive(form: FormData, href: string, firstName: string): EntryFormState {
  if (text(form, HYDRATED_FIELD) !== "1") redirect(href);
  return { error: null, firstName, href };
}

export async function startDemoAction(_previous: EntryFormState, form: FormData): Promise<EntryFormState> {
  const timeZone = text(form, "timeZone").slice(0, 64) || null;
  const result = await enterDemo(await entryRequest(), timeZone);
  if (result.kind === "refused") return result.state;
  return arrive(form, result.href, "");
}

export async function joinEventAction(
  target: { slug: string; next: string | null },
  _previous: EntryFormState,
  form: FormData,
): Promise<EntryFormState> {
  const session = await getSession(target.slug, await cookies());
  const firstName = text(form, "firstName");
  const result = await enterEvent(await entryRequest(), { slug: target.slug, firstName, next: target.next, session });
  if (result.kind === "refused") return result.state;
  return arrive(form, result.href, firstName);
}
