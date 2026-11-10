/**
 * The small marks design/21 and design/22 draw in Glim's panel, each at its drawn size. The paddle
 * marks are PaddleMark's; these are the rest.
 */
import { cn } from "../cn";

/** The lock of 07's held line and the rules lines: ink2 on rules, muted on a note. */
export function LockMark({ tone = "ink2", className }: { tone?: "ink2" | "muted"; className?: string }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn(tone === "ink2" ? "stroke-ink2" : "stroke-muted", className)}
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** A backup the guest hearted (V1). */
export function HeartMark() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20.5s-7.5-4.6-7.5-10.4A4.2 4.2 0 0 1 12 7.4a4.2 4.2 0 0 1 7.5 2.7c0 5.8-7.5 10.4-7.5 10.4z" className="fill-ink" />
    </svg>
  );
}

/** A backup the guest named in words (V1). */
export function BubbleMark() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v6.5a2.5 2.5 0 0 1-2.5 2.5H12l-4.5 3.8V16H6.5A2.5 2.5 0 0 1 4 13.5V7a2.5 2.5 0 0 1 2.5-2.5z" className="fill-ink" />
    </svg>
  );
}

/** Goes to another page of the event (19's "Set bidding power", "See my receipt"). */
export function ArrowRight() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** Opens a PayPal window (09's arrow). */
export function ArrowUpRight() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

/** The header's pause bars while a plan runs (design/22 #11), and the paused status mark at 10px. */
export function PauseMark({ size }: { size: 10 | 18 }) {
  return size === 18 ? (
    <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" className="fill-ink2">
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
  ) : (
    <svg width={10} height={10} viewBox="0 0 24 24" aria-hidden="true" className="flex-none fill-ink2">
      <rect x="5" y="4" width="5" height="16" rx="1.5" />
      <rect x="14" y="4" width="5" height="16" rx="1.5" />
    </svg>
  );
}

/** Resume's mark: lime on the ink button (a mark on black). */
export function PlayMark() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" className="fill-lime" />
    </svg>
  );
}

/** 09's spinner at the status line's size, while the autopilot decides (design/21 #4). */
export function SpinnerMark() {
  return (
    <svg width={10} height={10} viewBox="0 0 24 24" fill="none" strokeWidth={3.4} strokeLinecap="round" aria-hidden="true" className="flex-none animate-spin">
      <circle cx="12" cy="12" r="8.5" className="stroke-ink" strokeOpacity={0.16} />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" className="stroke-ink" />
    </svg>
  );
}
