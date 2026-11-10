"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PaddleFeedEntry, PaddleView } from "@/server/queries/paddle-view";

import { apiPost } from "../api";
import { Button } from "../Button";
import { cn } from "../cn";
import { formatClockTime, formatUsd } from "../format";
import { openGlim } from "../glim-events";
import { LockIcon } from "../icons";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";

import { PausedMark, PauseIcon, PlayMark } from "./icons";
import { keepLastWords } from "./text";

interface GlimActivityProps {
  slug: string;
  holdCents: number;
  glim: PaddleView["glim"];
  timeZone: string;
  /** design/23: with one row beside it, the card ends on that row's rule. */
  fitsOneRow: boolean;
}

/** 10's card: 07's header with Pause and Edit plan, the rule Glim works under, and every action on a quiet thread. */
export function GlimActivity({ slug, holdCents, glim, timeZone, fitsOneRow }: GlimActivityProps) {
  const clock = (at: number | null) => (at === null ? null : formatClockTime(at, timeZone));
  const { duty } = glim;
  return (
    <section aria-label="Glim’s activity" className="rounded-24 border border-line bg-white">
      <div className="flex h-67 items-center gap-12 border-b border-line px-16 max-md:h-auto max-md:flex-wrap max-md:gap-y-12 max-md:py-14">
        <Orb size={38} />
        <div>
          <b className="block text-15 leading-20 font-semibold">Glim’s activity</b>
          {duty.kind === "on" ? (
            <span className="mt-1 flex items-center gap-6 text-12 leading-16 whitespace-nowrap text-muted">
              <i className="block size-7 rounded-full bg-lime ring-[1.5px] ring-lime-edge" />
              {duty.since === null ? "On duty" : `On duty since ${clock(duty.since)}`}
            </span>
          ) : duty.kind === "paused" ? (
            <span className="mt-1 flex items-center gap-6 text-12 leading-16 whitespace-nowrap text-ink2">
              <PausedMark size={10} />
              {duty.since === null ? "Paused" : `Paused since ${clock(duty.since)}`}
            </span>
          ) : (
            <span className="mt-1 flex items-center gap-6 text-12 leading-16 whitespace-nowrap text-muted">
              <i className="block size-7 rounded-full bg-muted" />
              Not bidding yet
            </span>
          )}
        </div>
        <GlimControls slug={slug} duty={duty.kind} />
      </div>

      {glim.decides ? (
        <p className="grid grid-cols-[26px_minmax(0,1fr)] items-start gap-x-12 border-b border-line py-11 pr-20 pl-22 text-12.5 leading-18 whitespace-nowrap text-ink2 max-md:pr-16 max-md:pl-16 max-md:text-pretty max-md:whitespace-normal">
          <LockIcon size={14} className="mt-2 justify-self-center" />
          <span>
            <span className="block">Glim decides on its own inside your rules.</span>
            <span className="block">It can’t bid past your {formatUsd(holdCents)} bidding power.</span>
          </span>
        </p>
      ) : (
        <p className="grid h-40 grid-cols-[26px_minmax(0,1fr)] items-center gap-x-12 border-b border-line pr-20 pl-22 text-12.5 whitespace-nowrap text-ink2 max-md:h-auto max-md:items-start max-md:py-11 max-md:pr-16 max-md:pl-16 max-md:leading-18 max-md:text-pretty max-md:whitespace-normal">
          <LockIcon size={14} className="justify-self-center max-md:mt-2" />
          <span>Glim can’t bid past your limits or your {formatUsd(holdCents)} bidding power.</span>
        </p>
      )}

      <ol className={cn("list-none pt-20 pr-20 pl-22 max-md:pr-16 max-md:pl-16", glim.feed.length <= 1 && fitsOneRow ? "pb-21" : "pb-22")}>
        {glim.feed.length === 0 ? (
          <FeedItem time={null} label="NOTHING YET" line="Every bid I place for you will show here." chip={null} />
        ) : (
          glim.feed.map((entry) => <FeedItem key={entry.id} time={clock(entry.at)} label={entry.label} line={entry.line} chip={entry.chip} />)
        )}
      </ol>
    </section>
  );
}

function FeedItem({ time, label, line, chip }: { time: string | null; label: string; line: string; chip: PaddleFeedEntry["chip"] }) {
  return (
    <li className="relative grid grid-cols-[26px_minmax(0,1fr)] gap-x-12 pb-14 before:absolute before:top-32 before:bottom-6 before:left-[12.5px] before:w-1 before:bg-line last:pb-0 last:before:hidden">
      <Orb size={26} />
      <div>
        <span className="mt-6 block font-mono text-10.5 leading-14 tracking-label whitespace-nowrap text-muted">
          {time ? `${time} · ${label}` : label}
        </span>
        <p className="mt-4 text-13.5 leading-20 text-pretty">{keepLastWords(line)}</p>
        {chip?.kind === "winning" && (
          <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-lime pr-9 pl-6 text-11.5 font-semibold whitespace-nowrap inset-ring inset-ring-lime-edge">
            <PaddleMark tone="winning" size={13} />
            Winning · <Money cents={chip.amountCents} />
          </span>
        )}
        {chip?.kind === "closed" && (
          <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-closed pr-9 pl-6 text-11.5 font-semibold whitespace-nowrap text-ink2">
            <PaddleMark tone="closed" size={13} />
            Closed
          </span>
        )}
      </div>
    </li>
  );
}

const CONTROLS = "ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full max-md:gap-8";
const CONTROL = "max-md:h-44 max-md:flex-1 max-md:justify-center";

/** Talk to Glim before a plan; Edit plan and Pause while it runs; Edit plan and Resume while paused. */
function GlimControls({ slug, duty }: { slug: string; duty: "idle" | "on" | "paused" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const act = async (path: "/pause" | "/resume") => {
    setBusy(true);
    try {
      await apiPost(`/api/glim/${encodeURIComponent(slug)}${path}`);
    } catch {
      // The page reads the plan again either way, so it shows what really happened.
    } finally {
      setBusy(false);
      router.refresh();
    }
  };

  if (duty === "idle") {
    return (
      <div className={CONTROLS}>
        <Button variant="quiet" size={36} padding="px-14" className={CONTROL} onClick={() => openGlim()}>
          Talk to Glim
        </Button>
      </div>
    );
  }
  return (
    <div className={CONTROLS}>
      {/* 10's ghost button is medium weight, where Button's 36 is semibold. On a phone it takes the line edge, as one of two halves. */}
      <button
        type="button"
        className={cn(
          "inline-flex h-36 cursor-pointer items-center rounded-full border border-transparent px-11 text-13.5 font-medium whitespace-nowrap max-md:border-line",
          CONTROL,
        )}
        onClick={() => openGlim({ edit: true })}
      >
        Edit plan
      </button>
      {duty === "on" ? (
        <Button variant="quiet" size={36} disabled={busy} className={CONTROL} onClick={() => void act("/pause")}>
          <PauseIcon size={14} />
          Pause
        </Button>
      ) : (
        <Button variant="ink" size={36} disabled={busy} className={cn("border border-ink", CONTROL)} onClick={() => void act("/resume")}>
          <PlayMark size={14} />
          Resume
        </Button>
      )}
    </div>
  );
}
