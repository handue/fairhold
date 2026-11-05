import type { ReactNode } from "react";

import { cn } from "./cn";
import { PaddleMark } from "./PaddleMark";

/** One symbol per state: lime with a check for winning, an outline for outbid, grey for closed. */
export type PillStatus = "winning" | "outbid" | "closed";

const TONE: Record<PillStatus, string> = {
  winning: "bg-lime text-ink",
  outbid: "bg-white text-ink inset-ring-[1.5px] inset-ring-ink",
  closed: "bg-closed text-ink2",
};

interface StatusPillProps {
  status: PillStatus;
  children: ReactNode;
  /** A lime pill on a light surface gets the lime edge so it keeps its shape (lot tiles, rows). */
  edge?: boolean;
  className?: string;
}

export function StatusPill({ status, children, edge = false, className }: StatusPillProps) {
  return (
    <span
      className={cn(
        "inline-flex h-30 items-center gap-6 whitespace-nowrap rounded-full pr-12 pl-8 text-12.5 font-semibold",
        TONE[status],
        edge && status === "winning" && "inset-ring inset-ring-lime-edge",
        className,
      )}
    >
      <PaddleMark tone={status} size={16} />
      {children}
    </span>
  );
}
