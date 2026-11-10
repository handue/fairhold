/**
 * The marks of screens 09 and 05 that src/ui/icons.tsx does not have, on the same 24x24 grid: a new
 * window's arrow, the lock in the explainer's first figure (drawn slightly heavier than LockIcon),
 * and design/20's spinner, alert and notice marks.
 */
export function NewWindowIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

export function FigureLockIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="text-ink"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** design/20's waiting mark: a faint ring with an ink arc, turning. It takes an arrow's place. */
export function SpinnerIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.4}
      strokeLinecap="round"
      aria-hidden="true"
      className={className ? `animate-spin ${className}` : "animate-spin"}
    >
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeOpacity={0.14} />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="currentColor" />
    </svg>
  );
}

/** design/20's mark before an amount that can't be used: a ringed "!". */
export function AlertIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      aria-hidden="true"
      className="flex-none text-ink"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5" />
      <path d="M12 16.6v.01" />
    </svg>
  );
}

/** The marks in design/20's notice circle: a cross for a cancel, a bare "!" for a failure. */
export function NoticeMark({ kind }: { kind: "canceled" | "failed" }) {
  return kind === "canceled" ? (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" />
    </svg>
  ) : (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v9.5" />
      <path d="M12 19v.01" />
    </svg>
  );
}
