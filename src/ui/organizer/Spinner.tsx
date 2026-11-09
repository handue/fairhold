/** 20's rule for a job under way: a spinner where the arrow goes, in the ink at 14% and a quarter arc. */
export function Spinner({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" className="ledger-spin flex-none">
      <circle cx="12" cy="12" r="8.5" stroke="var(--color-ink)" strokeOpacity=".14" />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="var(--color-ink)" />
    </svg>
  );
}
