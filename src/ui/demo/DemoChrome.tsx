"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import type { GuideProgress } from "./demo-state";
import { publishDemoRole } from "./demo-store";
import { DemoGuide } from "./DemoGuide";

interface DemoChromeProps {
  slug: string;
  timeZone: string;
  /** The gala's creator, with paddle and guide progress; null for an invited guest. */
  organizer: { paddleId: string; paddleNumber: number; progress: GuideProgress } | null;
}

/**
 * The browser side of a demo gala's slot in the event layout: it tells the navs' pills who is
 * looking (./demo-store.ts), and docks the demo guide where design/18 draws it, on 08 alone. Other
 * pages have no free corner: 09's button and 05's photo reach the bottom left.
 */
export function DemoChrome({ slug, timeZone, organizer }: DemoChromeProps) {
  const pathname = usePathname();
  const isOrganizer = organizer !== null;

  useEffect(() => {
    publishDemoRole({ slug, isOrganizer, timeZone });
    return () => publishDemoRole(null);
  }, [slug, isOrganizer, timeZone]);

  if (!organizer || pathname !== `/e/${encodeURIComponent(slug)}`) return null;
  return <DemoGuide progress={organizer.progress} paddleId={organizer.paddleId} paddleNumber={organizer.paddleNumber} />;
}
