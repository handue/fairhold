"use client";

import type { ReactNode } from "react";

import { logPendingAction } from "./pending";

interface PendingButtonProps {
  /** The action this button will run once its server side exists, e.g. "openGlimChat". */
  action: string;
  details?: Record<string, string | number | boolean | null>;
  className?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  children: ReactNode;
}

/** A button that renders in its final form but only logs for now (see logPendingAction). */
export function PendingButton({ action, details, children, ...props }: PendingButtonProps) {
  return (
    <button type="button" onClick={() => logPendingAction(action, details)} {...props}>
      {children}
    </button>
  );
}
