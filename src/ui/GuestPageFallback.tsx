/** The static shell of a guest page while its data streams in: the nav's frame, nothing invented. */
export function GuestPageFallback() {
  return <div aria-busy="true" className="h-68 border-b border-line" />;
}
