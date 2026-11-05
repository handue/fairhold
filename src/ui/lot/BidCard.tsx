"use client";

import { useState } from "react";

import type { LotDetail } from "@/server/queries/types";

import { buttonClass } from "../Button";
import { cn } from "../cn";
import { Eyebrow } from "../Eyebrow";
import { formatBidCount } from "../format";
import { ClockIcon, LockIcon } from "../icons";
import { Countdown } from "../LiveTime";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { logPendingAction } from "../pending";
import { StatusPill } from "../StatusPill";

const presetClass = "flex h-46 cursor-pointer items-center justify-center rounded-12 border text-14 font-medium";

/** 05's bid card: the current bid and countdown, "Raise to" presets, Place bid and the agent link. */
export function BidCard({ lot }: { lot: LotDetail }) {
  const [selected, setSelected] = useState(0);
  const amountCents = lot.presetCents[selected] ?? lot.nextMinimumCents;

  return (
    <section aria-label="Place a bid" className="mt-22 rounded-22 border border-line p-20">
      <div className="flex items-center justify-between">
        <Eyebrow>{lot.currentBidCents === null ? "Starting bid" : "Current bid"}</Eyebrow>
        {lot.viewerStatus === "winning" && <StatusPill status="winning">You’re winning</StatusPill>}
        {lot.viewerStatus === "outbid" && <StatusPill status="outbid">You’re outbid</StatusPill>}
      </div>
      <p className="mt-12 font-mono text-56 leading-none font-medium tracking-display">
        <Money cents={lot.currentBidCents ?? lot.startingBidCents} />
      </p>
      <div className="mt-12 flex gap-16 text-13 text-ink2">
        <span className="inline-flex items-center gap-6">{formatBidCount(lot.bidCount)}</span>
        <span className="inline-flex items-center gap-6">
          <ClockIcon size={14} />
          Closes in <Countdown closesAt={lot.closesAt} className="font-mono" />
        </span>
      </div>

      <Eyebrow className="mt-20">Raise to</Eyebrow>
      <div role="radiogroup" aria-label="Raise to" className="mt-8 grid grid-cols-4 gap-8 font-mono">
        {lot.presetCents.map((cents, index) => (
          <button
            key={cents}
            type="button"
            role="radio"
            aria-checked={index === selected}
            onClick={() => setSelected(index)}
            className={cn(presetClass, index === selected ? "border-ink bg-ink text-white" : "border-line")}
          >
            <Money cents={cents} />
          </button>
        ))}
        <button
          type="button"
          onClick={() => logPendingAction("setMaxBid", { lot: lot.number })}
          className={cn(presetClass, "border-line font-sans")}
        >
          Max…
        </button>
      </div>

      <button
        type="button"
        onClick={() => logPendingAction("placeBid", { lot: lot.number, amountCents })}
        className={buttonClass({ variant: "lime", size: 56, fullWidth: true, className: "mt-12 justify-between" })}
      >
        <span>Place bid</span>
        <span className="font-mono">
          <Money cents={amountCents} />
        </span>
      </button>
      <p className="mt-12 flex items-center gap-8 text-12.5 text-ink2">
        <LockIcon size={15} />
        Held with PayPal. You’re only charged if you win.
      </p>

      <button
        type="button"
        onClick={() => logPendingAction("openGlimChat", { lot: lot.number })}
        className="mt-18 flex w-full cursor-pointer items-center gap-10 border-t border-line pt-18 text-14 font-semibold"
      >
        <Orb size={26} glow="soft" />
        Let the agent bid on this lot
        <span aria-hidden="true" className="ml-auto font-medium text-muted">
          →
        </span>
      </button>
    </section>
  );
}
