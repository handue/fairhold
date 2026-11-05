/**
 * The paddle: a rounded head on a straight handle, in a 24x24 box. Its geometry is fixed by the
 * brand rules and it is never rotated. Each tone is one status symbol from the approved screens.
 */
export type PaddleTone =
  /** Lime head outlined in ink: the brand mark. */
  | "brand"
  /** Ink paddle with a lime check: you're winning. */
  | "winning"
  /** White head outlined in ink: you're outbid. */
  | "outbid"
  /** Grey paddle: closed. */
  | "closed";

const HEAD = { x: 4, y: 1.5, width: 16, height: 13.5, rx: 4 } as const;
const HANDLE = { x: 10.75, y: 14, width: 2.5, height: 8.5, rx: 1.25 } as const;
const CHECK = "M8.6 8.4l2.3 2.2 4.5-4.6";

interface PaddleMarkProps {
  tone?: PaddleTone;
  size?: number;
  className?: string;
}

export function PaddleMark({ tone = "brand", size = 24, className }: PaddleMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <PaddleShape tone={tone} size={size} />
    </svg>
  );
}

function PaddleShape({ tone, size }: { tone: PaddleTone; size: number }) {
  switch (tone) {
    case "brand":
      return (
        <>
          <rect {...HEAD} className="fill-lime stroke-ink" strokeWidth={1.5} />
          <rect {...HANDLE} className="fill-ink" />
        </>
      );
    case "winning":
      return (
        <>
          <rect {...HEAD} className="fill-ink" />
          <rect {...HANDLE} className="fill-ink" />
          {/* The smallest marks (13px chips) draw the check a little heavier to stay legible. */}
          <path
            d={CHECK}
            className="stroke-lime"
            strokeWidth={size < 16 ? 2.2 : 2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "outbid":
      return (
        <>
          <rect {...HEAD} className="fill-white stroke-ink" strokeWidth={1.5} />
          <rect {...HANDLE} className="fill-ink" />
        </>
      );
    case "closed":
      return (
        <>
          <rect {...HEAD} className="fill-muted" />
          <rect {...HANDLE} className="fill-muted" />
        </>
      );
  }
}
