"use client";

import { usePathname } from "next/navigation";
import { Suspense } from "react";

import { eventSlugFromPath } from "../event/event-path";

/**
 * A page of a live event that does not exist, such as a lot number past the last. No image: it
 * takes 16c's column and 17's quiet button, and leads back to the event's lots.
 */
export function EventPageNotFound() {
  return (
    <main className="mx-auto flex w-880 flex-col items-center pt-230 text-center">
      <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Not found</p>
      <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title">We could not find this page</h1>
      {/* usePathname suspends while Next builds a dynamic route's static shell. */}
      <Suspense fallback={null}>
        <BackToTheLots />
      </Suspense>
    </main>
  );
}

function BackToTheLots() {
  const slug = eventSlugFromPath(usePathname() ?? "");
  // A full load: the page notFound() left behind may not be React's to remove.
  return (
    <a
      href={slug ? `/e/${encodeURIComponent(slug)}` : "/"}
      className="mt-24 inline-flex h-40 items-center rounded-12 border border-line px-18 text-13.5 font-semibold text-ink"
    >
      {slug ? "Back to the lots" : "Go to Fairhold"}
    </a>
  );
}
