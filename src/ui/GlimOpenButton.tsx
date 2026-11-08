"use client";

import type { ReactNode } from "react";

import { openGlim, type GlimOpenDetail } from "./glim-events";

interface GlimOpenButtonProps {
  detail?: GlimOpenDetail;
  className?: string;
  "aria-label"?: string;
  children: ReactNode;
}

/** A button a server component can render that opens Glim (see glim-events.ts). */
export function GlimOpenButton({ detail, children, ...props }: GlimOpenButtonProps) {
  return (
    <button type="button" onClick={() => openGlim(detail)} {...props}>
      {children}
    </button>
  );
}
