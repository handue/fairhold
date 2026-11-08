import type { ReactNode } from "react";

import { exampleWinCents } from "@/server/holds/rules";

import { cn } from "../cn";
import { Eyebrow } from "../Eyebrow";
import { formatUsd } from "../format";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";

import { FigureLockIcon } from "./icons";

const FIGURES = "mt-24 flex h-22 items-center text-13 whitespace-nowrap text-muted";
const FIGURE = "flex min-w-0 items-center gap-6";
const AMOUNT = "font-mono text-13 font-medium text-ink";
const FIGURE_NOTE = "-ml-1 not-italic";
const BAR = "mt-8 flex h-10";
const INK = "block h-full bg-ink";
const LIME = "block h-full bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]";

function Step({ label, first = false, last = false, children }: { label: string; first?: boolean; last?: boolean; children: ReactNode }) {
  return (
    <article>
      <div className="flex h-16 items-center gap-8">
        <i
          className={cn(
            "block size-8 flex-none rounded-4",
            first ? "bg-ink" : "bg-white shadow-[inset_0_0_0_1.5px_var(--color-on-ink-muted)]",
          )}
        />
        <span
          className={cn(
            "font-mono text-11 tracking-label whitespace-nowrap uppercase",
            first ? "font-medium text-ink" : "text-muted",
          )}
        >
          {label}
        </span>
        {!last && <i className="-mr-24 block h-1 flex-1 bg-[rgba(11,11,12,.14)]" />}
      </div>
      {children}
    </article>
  );
}

function Caption({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-24">
      <b className="block text-15 leading-20 font-semibold tracking-[-.005em]">{title}</b>
      <span className="mt-4 block text-13 leading-18 text-muted">{children}</span>
    </div>
  );
}

interface HowTheHoldWorksProps {
  holdCents: number;
  /** "9:30 PM", when the event closes. */
  closesLabel: string;
  /** The lot the example names, or null for an event with none open. */
  exampleLot: string | null;
}

/** 09's explainer: one bar at three moments. Every figure follows the amount chosen. */
export function HowTheHoldWorks({ holdCents, closesLabel, exampleLot }: HowTheHoldWorksProps) {
  const winCents = exampleWinCents(holdCents);
  const restCents = holdCents - winCents;
  const win = { flex: `${winCents / 100} 1 0` };
  const rest = { flex: `${restCents / 100} 1 0` };
  const hold = formatUsd(holdCents);

  return (
    <section aria-label="How the hold works" className="mt-40 w-880 rounded-24 bg-surface p-32 text-left">
      <div className="flex h-16 items-center justify-between">
        <Eyebrow className="leading-16">How the hold works</Eyebrow>
        <span className="text-13 text-muted">
          Example: you win {exampleLot ? `the ${exampleLot}` : "a lot"} at {formatUsd(winCents)}
        </span>
      </div>

      <div className="mt-24 grid grid-cols-3 gap-x-32">
        <Step label="When you approve" first>
          <div className={cn(FIGURES, "gap-2")}>
            <span className={FIGURE}>
              <FigureLockIcon />
              <b className={AMOUNT}>
                <Money cents={holdCents} />
              </b>
            </span>
          </div>
          <div className={cn(BAR, "gap-2")} aria-hidden="true">
            <i className={cn(LIME, "flex-1 rounded-[5px]")} />
          </div>
          <Caption title="Held, not charged">It covers your bids on every lot.</Caption>
        </Step>

        <Step label="While you bid">
          <div className={cn(FIGURES, "gap-2")}>
            <span className={FIGURE} style={win}>
              <PaddleMark tone="brand" size={16} />
              <Orb size={22} />
            </span>
            <span className={cn(FIGURE, "justify-end")} style={rest}>
              <b className={AMOUNT}>
                <Money cents={restCents} />
              </b>
              <em className={FIGURE_NOTE}>left</em>
            </span>
          </div>
          <div className={cn(BAR, "gap-2")} aria-hidden="true">
            <i className={cn(INK, "rounded-l-[5px]")} style={win} />
            <i className={cn(LIME, "rounded-r-[5px]")} style={rest} />
          </div>
          <Caption title={`Never over ${hold}`}>Your bids and Glim’s stay within it.</Caption>
        </Step>

        <Step label={`After ${closesLabel}`} last>
          <div className={cn(FIGURES, "gap-6")}>
            <span className={FIGURE} style={win}>
              <PaddleMark tone="winning" size={16} />
              <b className={AMOUNT}>
                <Money cents={winCents} />
              </b>
              <em className={FIGURE_NOTE}>paid</em>
            </span>
            <span className={cn(FIGURE, "justify-end")} style={rest}>
              <b className={AMOUNT}>
                <Money cents={restCents} />
              </b>
              <em className={FIGURE_NOTE}>released</em>
            </span>
          </div>
          <div className={cn(BAR, "gap-6")} aria-hidden="true">
            <i className={cn(INK, "rounded-[5px]")} style={win} />
            <i className={cn(LIME, "rounded-[5px]")} style={rest} />
          </div>
          <Caption title="Pay only for lots you win">Win nothing? All {hold} is released.</Caption>
        </Step>
      </div>
    </section>
  );
}
