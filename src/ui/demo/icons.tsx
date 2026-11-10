import type { ReactNode } from "react";

/**
 * The line icons of design/16 to 18 that the shared set does not have, on its 24x24 grid. They
 * stroke with currentColor, so a text color class sets their color.
 */
interface IconProps {
  size: number;
  className?: string;
  strokeWidth?: number;
}

function Line({ size, className, strokeWidth = 2, children }: IconProps & { children: ReactNode }) {
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

export function CheckIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Line>
  );
}

export function CloseLotIcon(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Line>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="12" r="9" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </Line>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M12 5v14M5 12h14" />
    </Line>
  );
}

export function InviteIcon(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="10" cy="8" r="3.5" />
      <path d="M3.5 20c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
      <path d="M19 8v6M16 11h6" />
    </Line>
  );
}

export function ResetIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" />
      <path d="M4.5 4.5v4.5H9" />
    </Line>
  );
}

/** 16c: 10's lock with its shackle open, released rather than held. */
export function OpenLockIcon(props: IconProps) {
  return (
    <Line {...props}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 7.46-2" />
    </Line>
  );
}

/** 20's help line on an error: a circled mark. */
export function AlertIcon(props: IconProps) {
  return (
    <Line {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.6v.01" />
    </Line>
  );
}

/** 17 frame 4: try again from the gala tab. */
export function ReturnIcon(props: IconProps) {
  return (
    <Line {...props}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Line>
  );
}
