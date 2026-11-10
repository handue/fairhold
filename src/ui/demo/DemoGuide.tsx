"use client";

import { useId, useState } from "react";

import { cn } from "../cn";
import { ChevronDownIcon } from "../icons";
import { useStreamEvent } from "../live/LiveStream";

import type { GuideProgress } from "./demo-state";
import { guideView, stepDoneBy, withStepDone, type GuideView } from "./guide";
import { CheckIcon } from "./icons";

interface DemoGuideProps {
  progress: GuideProgress;
  paddleId: string;
  paddleNumber: number;
}

/**
 * design/18's demo guide, docked in 08's free bottom-left corner the way Glim's bubble docks in the
 * right one: the bubble's card, 32px in and 28px up. With design/21's V5 it has five steps, so the
 * grid runs to a third row; the card's insets are 8px (not 14.5) and its gaps 12px (not 16 and 20),
 * which keeps it clear of 08's second row of prices and of "Show 16 more lots". While the heart step
 * is now, its second sentence takes one more line. It moves on from the stream, with no refresh.
 *
 * Below 1280, and below 1440 on a screen under 860 tall, there is no free corner: the card, more than
 * half of a 1024 screen, and Glim's bubble would cover the second row of lots on the first screen (and
 * on a phone Glim's corner takes the bottom of the screen). So the guide folds into a bar that opens
 * upwards: CompactGuide.
 */
export function DemoGuide({ progress: initial, paddleId, paddleNumber }: DemoGuideProps) {
  const [progress, setProgress] = useState(initial);
  // A server render with newer facts (after a refresh) wins over what the stream added.
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) {
    setSeen(initial);
    setProgress(initial);
  }

  useStreamEvent((row) => {
    const step = stepDoneBy(row, { paddleId, paddleNumber });
    if (step) setProgress((current) => withStepDone(current, step));
  });

  const view = guideView(progress);
  return (
    <>
      <DockedGuide view={view} />
      <CompactGuide view={view} />
    </>
  );
}

/** The approved card, from 1280 up on a screen at least 860 tall, and from 1440 on every screen. */
function DockedGuide({ view }: { view: GuideView }) {
  return (
    <aside
      aria-label="Demo guide"
      className="fixed bottom-28 left-32 z-20 flex items-center rounded-18 border border-line bg-white px-16 py-8 shadow-bubble max-desk:[@media(max-height:859px)]:hidden max-xl:hidden"
    >
      <div>
        <b className="block text-13.5 font-semibold whitespace-nowrap">Demo guide</b>
        <span className="mt-2 block text-12.5 whitespace-nowrap text-muted">
          Step {view.position} of {view.total}
        </span>
      </div>
      <span aria-hidden="true" className="mx-12 h-40 w-1 flex-none bg-line" />
      <ol className="grid grid-cols-[auto_auto] gap-x-12 gap-y-8">
        {view.steps.flatMap((step) => {
          const item = (
            <li
              key={step.key}
              aria-current={step.state === "now" ? "step" : undefined}
              className={cn(
                "flex h-22 items-center gap-8 text-13 whitespace-nowrap",
                step.state === "done" && "text-muted",
                step.state === "now" && "font-semibold text-ink",
                step.state === "next" && "text-ink2",
              )}
            >
              <StepNumber number={step.number} state={step.state} />
              {step.label}
              {step.detail && <span className="sr-only"> {step.detail}</span>}
            </li>
          );
          // V5's second sentence, under the step while it is now. One line across both columns, so
          // the card grows by a line rather than a column.
          if (!step.detail) return [item];
          return [
            item,
            <li key={`${step.key}-detail`} aria-hidden="true" className="col-span-2 -mt-6 pl-30 text-12.5 leading-18 whitespace-nowrap text-muted">
              {step.detail}
            </li>,
          ];
        })}
      </ol>
    </aside>
  );
}

/**
 * Where the card doesn't fit: a 44px bar, "Demo guide · Step 1 of 5" with the step's number, that
 * opens the steps in one column above it. From 768 it takes the card's corner. On a phone from 360 it
 * sits beside Glim's orb, centred on its 56px row (16 + 242 + 16 + 56 + 16 = 346); below 360 there is
 * no room beside it, so it sits over Glim's corner (the bottom 88px), at the left gutter.
 */
function CompactGuide({ view }: { view: GuideView }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const now = view.steps[view.position - 1];
  return (
    <aside
      aria-label="Demo guide"
      className="fixed bottom-28 left-32 z-20 hidden max-w-[calc(100vw-64px)] flex-col items-start gap-8 max-desk:[@media(max-height:859px)]:flex max-xl:flex max-md:bottom-[calc(88px+env(safe-area-inset-bottom))] max-md:left-16 max-md:max-w-[calc(100vw-32px)] max-md:min-[360px]:bottom-[calc(22px+env(safe-area-inset-bottom))] max-md:min-[360px]:max-w-[calc(100vw-104px)]"
    >
      {open && (
        <ol
          id={listId}
          className="flex w-320 max-w-full flex-col gap-10 rounded-18 border border-line bg-white p-14 shadow-bubble"
        >
          {view.steps.map((step) => (
            <li
              key={step.key}
              aria-current={step.state === "now" ? "step" : undefined}
              className={cn(
                "grid grid-cols-[22px_minmax(0,1fr)] gap-x-8 text-14 leading-22",
                step.state === "done" && "text-muted",
                step.state === "now" && "font-semibold text-ink",
                step.state === "next" && "text-ink2",
              )}
            >
              <StepNumber number={step.number} state={step.state} />
              {step.label}
              {step.detail && <span className="col-start-2 text-13 leading-18 font-normal text-muted">{step.detail}</span>}
            </li>
          ))}
        </ol>
      )}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex h-44 max-w-full cursor-pointer items-center gap-8 rounded-full border border-line bg-white pr-14 pl-10 text-14 whitespace-nowrap shadow-bubble"
      >
        {now && (
          <span aria-hidden="true" className="flex">
            <StepNumber number={now.number} state={now.state} />
          </span>
        )}
        <b className="font-semibold">Demo guide</b>{" "}
        <span className="text-muted">
          · Step {view.position} of {view.total}
        </span>
        <ChevronDownIcon size={16} className={cn("flex-none text-ink2", !open && "rotate-180")} />
      </button>
    </aside>
  );
}

/** 07's plan numbers: done is ink with a lime tick, now is lime, next is the closed grey. */
function StepNumber({ number, state }: { number: number; state: "done" | "now" | "next" }) {
  if (state === "done") {
    return (
      <span aria-label="Done" className="flex size-22 flex-none items-center justify-center rounded-full bg-ink text-lime">
        <CheckIcon size={12} strokeWidth={3} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "flex size-22 flex-none items-center justify-center rounded-full font-mono text-11 font-semibold",
        state === "now" ? "bg-lime text-ink shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" : "bg-closed text-ink2",
      )}
    >
      {number}
    </span>
  );
}
