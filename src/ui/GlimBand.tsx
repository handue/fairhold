import type { ViewerSummary } from "@/server/queries/types";

import { buttonClass } from "./Button";
import { GlimOpenButton } from "./GlimOpenButton";
import { ArrowRightIcon, LockIcon } from "./icons";
import { Orb } from "./Orb";
import { StatusPill } from "./StatusPill";

/** 08's ink band: what the hold means, the viewer's bids, and the call to let Glim bid. */
export function GlimBand({ viewer }: { viewer: ViewerSummary }) {
  const hasBids = viewer.winningCount > 0 || viewer.outbidCount > 0;

  return (
    <section aria-label="My paddle" className="flex h-64 items-center rounded-24 bg-ink px-8 text-white">
      <div className="flex items-center gap-14">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white/8">
          <LockIcon size={18} className="text-white" />
        </span>
        <div>
          <p className="text-15 leading-20 font-semibold">Bidding power held with PayPal</p>
          <p className="text-13 leading-18 text-on-ink-muted">You’re only charged for lots you win.</p>
        </div>
      </div>

      {hasBids && (
        <>
          <span aria-hidden="true" className="mx-32 h-32 w-1 flex-none bg-white/14" />
          <div className="flex items-center gap-8">
            <span className="mr-8 font-mono text-10.5 tracking-caps text-on-ink-muted uppercase">My bids</span>
            {viewer.winningCount > 0 && <StatusPill status="winning">{viewer.winningCount} winning</StatusPill>}
            {viewer.outbidCount > 0 && <StatusPill status="outbid">{viewer.outbidCount} outbid</StatusPill>}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-12">
        <Orb size={32} />
        <GlimOpenButton
          className={buttonClass({
            variant: "lime",
            size: 48,
            padding: "pr-18 pl-20",
            className: "focus-visible:outline-lime",
          })}
        >
          Let Glim bid for me
          <ArrowRightIcon size={18} />
        </GlimOpenButton>
      </div>
    </section>
  );
}
