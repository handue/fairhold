import type { ReactNode } from "react";

import { cn } from "./cn";

interface EyebrowProps {
  children: ReactNode;
  /** md: labels on the lot page ("CURRENT BID"); sm: the lot line under a tile ("LOT 07 · DINING"). */
  size?: "md" | "sm";
  className?: string;
}

/** The uppercase mono label above titles, figures and lists. */
export function Eyebrow({ children, size = "md", className }: EyebrowProps) {
  return (
    <p
      className={cn(
        "font-mono tracking-caps text-muted uppercase",
        size === "md" ? "text-11.5" : "text-11 leading-14",
        className,
      )}
    >
      {children}
    </p>
  );
}
