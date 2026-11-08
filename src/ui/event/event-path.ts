/** The event slug in a pathname like /e/<slug>/lots/07, or null outside an event. */
export function eventSlugFromPath(pathname: string): string | null {
  const match = /^\/e\/([^/]+)/.exec(pathname);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
