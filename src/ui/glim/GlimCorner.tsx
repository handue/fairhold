"use client";

import type { ReactNode } from "react";

import { toggleGlimPanel, useGlimBubbleVisible } from "./panel-state";

/** The corner's speech bubble, which steps aside while the panel is open (see useGlimBubbleVisible). */
export function GlimCornerBubble({ invitation, children }: { invitation: boolean; children: ReactNode }) {
  return useGlimBubbleVisible({ invitation }) ? children : null;
}

/** The corner's orb: it opens the panel, and closes it again. */
export function GlimCornerButton({ children }: { children: ReactNode }) {
  return (
    <button type="button" onClick={toggleGlimPanel} aria-label="Chat with Glim" className="cursor-pointer rounded-full max-md:size-56">
      {children}
    </button>
  );
}
