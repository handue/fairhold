/**
 * The marks 10, 11 and 14 draw that the shared icons (src/ui/icons.tsx) do not have, copied from the
 * approved HTML. Line icons stroke with currentColor, so a text color class sets their color.
 */
import type { ReactNode } from "react";

interface IconProps {
  size: number;
  className?: string;
}

function Line({ size, className, strokeWidth = 2, children }: IconProps & { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Raise bidding power: another PayPal window. */
export function ArrowUpRightIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </Line>
  );
}

/** 25's released hold: the lock's shackle open. */
export function OpenLockIcon(props: IconProps) {
  return (
    <Line {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.46-2" />
    </Line>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M12 4v11" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 20h14" />
    </Line>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <Line {...props} strokeWidth={1.8}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="M4.5 7.5l7.5 5.5 7.5-5.5" />
    </Line>
  );
}

/** 10's Pause button: two bars. */
export function PauseIcon({ size, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="6" y="5" width="4" height="14" rx="1.5" />
      <rect x="14" y="5" width="4" height="14" rx="1.5" />
    </svg>
  );
}

/** 23's paused status mark: two wider bars. */
export function PausedMark({ size, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <rect x="5" y="4" width="5" height="16" rx="1.5" />
      <rect x="14" y="4" width="5" height="16" rx="1.5" />
    </svg>
  );
}

/** 23's Resume: a lime play mark on ink. */
export function PlayMark({ size, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className={className}>
      <path d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z" className="fill-lime" />
    </svg>
  );
}

/** 20's waiting mark: a quarter ring turning on a faint full one. */
export function SpinnerIcon({ size, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true" className={className}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity={0.14} />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="currentColor" />
    </svg>
  );
}

/** 10's cause line. */
export function HeartLineIcon({ size, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}
