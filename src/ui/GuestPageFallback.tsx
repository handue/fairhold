/**
 * The static shell of a guest page while its data streams in: the nav's frame, nothing invented.
 * Below 1024 the nav is two rows (70 and 48, with the rule), so the frame is that tall.
 */
export function GuestPageFallback() {
  return <div aria-busy="true" className="h-68 border-b border-line max-lg:h-119" />;
}
