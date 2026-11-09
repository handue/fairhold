"use client";

import { useState } from "react";

import { cn } from "../cn";
import { useStreamEvent } from "../live/LiveStream";

import type { GuideProgress } from "./demo-state";
import { guideView, stepDoneBy, withStepDone } from "./guide";
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
    <aside
      aria-label="Demo guide"
      className="fixed bottom-28 left-32 z-20 flex items-center rounded-18 border border-line bg-white px-16 py-8 shadow-bubble"
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
