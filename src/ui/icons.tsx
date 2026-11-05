import type { ReactNode } from "react";

/**
 * The line icons of the approved screens, on a 24x24 grid. They stroke with currentColor, so a
 * text color class sets their color.
 */
interface IconProps {
  size: number;
  className?: string;
}

interface LineIconProps extends IconProps {
  strokeWidth: number;
  /** The clock and the heart use the browser's default caps or joins in the mockups. */
  linecap?: "round";
  linejoin?: "round";
  children: ReactNode;
}

function LineIcon({ size, className, strokeWidth, linecap, linejoin, children }: LineIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap={linecap}
      strokeLinejoin={linejoin}
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <LineIcon {...props} strokeWidth={2} linecap="round" linejoin="round">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </LineIcon>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <LineIcon {...props} strokeWidth={2} linecap="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </LineIcon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <LineIcon {...props} strokeWidth={2} linecap="round" linejoin="round">
      <path d="M5 12h14" />
      <path d="M13 6l6 6-6 6" />
    </LineIcon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <LineIcon {...props} strokeWidth={2} linecap="round" linejoin="round">
      <path d="M6 9l6 6 6-6" />
    </LineIcon>
  );
}

export function HeartIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <LineIcon {...props} strokeWidth={1.8} linejoin="round">
      <path
        d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"
        fill={filled ? "currentColor" : "none"}
      />
    </LineIcon>
  );
}

export function ShareIcon(props: IconProps) {
  return (
    <LineIcon {...props} strokeWidth={1.8} linecap="round" linejoin="round">
      <path d="M12 4v11" />
      <path d="M8 8l4-4 4 4" />
      <path d="M5 13v6h14v-6" />
    </LineIcon>
  );
}
