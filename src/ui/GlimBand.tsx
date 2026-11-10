import Link from "next/link";

import type { ViewerSummary } from "@/server/queries/types";

import { buttonClass } from "./Button";
import { GlimOpenButton } from "./GlimOpenButton";
import { ArrowRightIcon, LockIcon } from "./icons";
import { Orb } from "./Orb";
import { StatusPill } from "./StatusPill";

/**
 * 08's ink band: what the hold means, the viewer's bids, and the call to let Glim bid. Once bidding
 * has closed there is nothing left for Glim to bid on, so `receiptHref` puts 11 in the call's place,
 * with 12's "See your receipt" (C3). This state is not drawn.
 */
export function GlimBand({ viewer, receiptHref }: { viewer: ViewerSummary; receiptHref?: string }) {
  const hasBids = viewer.winningCount > 0 || viewer.outbidCount > 0;

  return (
    // Below 1024 the band becomes a grid: the hold and the call on top, the bids under a hairline. On a
    // phone everything stacks and the call takes the band's width.
    <section
      aria-label="My paddle"
      className="flex h-64 items-center rounded-24 bg-ink px-8 text-white max-lg:grid max-lg:h-auto max-lg:grid-cols-[minmax(0,1fr)_auto] max-lg:gap-x-16 max-lg:py-8 max-md:grid-cols-1 max-md:pr-8"
    >
      <div className="flex items-center gap-14 max-lg:col-start-1 max-lg:row-start-1 max-md:pr-8">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white/8">
          <LockIcon size={18} className="text-white" />
        </span>
        <div>
          <p className="text-15 leading-20 font-semibold max-md:text-balance">Bidding power held with PayPal</p>
          <p className="text-13 leading-18 text-on-ink-muted max-md:text-balance">You’re only charged for lots you win.</p>
        </div>
      </div>

      {hasBids && (
        <>
          <span aria-hidden="true" className="mx-32 h-32 w-1 flex-none bg-white/14 max-lg:hidden" />
          <div className="flex items-center gap-8 max-lg:col-span-2 max-lg:row-start-2 max-lg:mx-6 max-lg:mt-8 max-lg:flex-wrap max-lg:border-t max-lg:border-white/14 max-lg:pt-12 max-lg:pb-4 max-md:col-span-1 max-md:gap-6">
            <span className="mr-8 font-mono text-10.5 tracking-caps text-on-ink-muted uppercase max-md:mr-2">My bids</span>
            {viewer.winningCount > 0 && <StatusPill status="winning">{viewer.winningCount} winning</StatusPill>}
            {viewer.outbidCount > 0 && <StatusPill status="outbid">{viewer.outbidCount} outbid</StatusPill>}
          </div>
        </>
      )}

      {receiptHref ? (
        <Link
          href={receiptHref}
          className={buttonClass({
            variant: "lime",
            size: 48,
            padding: "pr-18 pl-20",
            className:
              "ml-auto focus-visible:outline-lime max-lg:col-start-2 max-lg:row-start-1 max-md:col-start-1 max-md:row-start-3 max-md:mt-8 max-md:ml-0 max-md:justify-between",
          })}
        >
          See your receipt
          <ArrowRightIcon size={18} />
        </Link>
      ) : (
        <div className="ml-auto flex items-center gap-12 max-lg:col-start-2 max-lg:row-start-1 max-md:col-start-1 max-md:row-start-3 max-md:mt-8 max-md:ml-0 max-md:pl-6">
          <Orb size={32} />
          <GlimOpenButton
            className={buttonClass({
              variant: "lime",
              size: 48,
              padding: "pr-18 pl-20",
              className: "focus-visible:outline-lime max-md:flex-1 max-md:justify-between",
            })}
          >
            Let Glim bid for me
            <ArrowRightIcon size={18} />
          </GlimOpenButton>
        </div>
      )}
    </section>
  );
}
