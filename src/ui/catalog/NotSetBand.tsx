import Link from "next/link";

import { buttonClass } from "../Button";
import { ArrowRightIcon } from "../icons";

/**
 * design/20 state 1: 08's ink band before bidding power is set. It takes GlimBand's place and leads
 * to 09; the nav's pill says "Not set" beside it.
 */
export function NotSetBand({ href }: { href: string }) {
  return (
    // On a phone the call drops under the words and takes the band's width.
    <section
      aria-label="Bidding power not set"
      className="flex h-64 items-center rounded-24 bg-ink px-8 text-white max-md:h-auto max-md:flex-col max-md:items-stretch max-md:gap-16 max-md:py-8"
    >
      <div className="flex items-center gap-14 max-md:pr-8">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white/8">
          {/* The paddle in its brand colors, with a white handle so it reads on ink. Never rotated. */}
          <svg width={20} height={20} viewBox="0 0 24 24" aria-hidden="true">
            <rect x="4" y="1.5" width="16" height="13.5" rx="4" className="fill-lime stroke-ink" strokeWidth={1.5} />
            <rect x="10.75" y="14" width="2.5" height="8.5" rx="1.25" className="fill-white" />
          </svg>
        </span>
        <div>
          <p className="text-15 leading-20 font-semibold max-md:text-balance">Set your bidding power to start bidding</p>
          <p className="text-13 leading-18 text-on-ink-muted max-md:text-balance">It’s a hold with PayPal, not a charge.</p>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-12 max-md:ml-0">
        <Link
          href={href}
          className={buttonClass({
            variant: "lime",
            size: 48,
            padding: "pr-18 pl-20",
            className: "focus-visible:outline-lime max-md:flex-1 max-md:justify-between",
          })}
        >
          Set bidding power
          <ArrowRightIcon size={18} />
        </Link>
      </div>
    </section>
  );
}
