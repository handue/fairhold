import Link from "next/link";

import { Money } from "./Money";

const PILL =
  "flex h-40 items-center gap-10 rounded-full bg-ink px-14 font-mono text-13 text-white max-desk:flex-none max-desk:whitespace-nowrap";

/**
 * The nav pill once bidding has closed: what was paid and released, or what will be. 11 shows it in
 * bidding power's place, and so does every other guest page after the close, as a link to 11. On a
 * phone it keeps the two figures beside the tabs, as bidding power does.
 */
export function OutcomePill({
  settled,
  payCents,
  releaseCents,
  href,
}: {
  settled: boolean;
  payCents: number;
  releaseCents: number;
  /** Set on the pages that aren't the receipt, so the pill leads there. */
  href?: string;
}) {
  const paid = settled ? "Paid" : "To pay";
  const released = settled ? "Released" : "To release";
  const content = (
    <>
      <span className="flex items-center gap-10">
        <small className="text-10.5 tracking-label text-on-ink-muted uppercase max-md:hidden">{paid}</small>
        <span className="sr-only hidden max-md:inline">{paid}</span>
        <b className="font-medium">
          <Money cents={payCents} />
        </b>
      </span>
      <span className="text-on-ink-muted">·</span>
      <span className="flex items-center gap-10">
        <small className="text-10.5 tracking-label text-on-ink-muted uppercase max-md:hidden">{released}</small>
        <span className="sr-only hidden max-md:inline">{released}</span>
        <b className="font-medium text-lime">
          <Money cents={releaseCents} />
        </b>
      </span>
    </>
  );
  return href ? (
    <Link href={href} className={PILL}>
      {content}
    </Link>
  ) : (
    <div className={PILL}>{content}</div>
  );
}
