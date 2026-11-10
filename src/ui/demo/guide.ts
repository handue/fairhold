/**
 * The demo guide (design/18, with design/21's V5 step) as plain data: which step is done, which is
 * now, and how a live row moves it on. No React, so the rules are tested on their own.
 */
import type { StreamEvent } from "@/server/sse/types";

import type { GuideProgress, GuideStep } from "./demo-state";

export const GUIDE_LABELS: Record<GuideStep, { label: string; detail?: string }> = {
  power: { label: "Set bidding power" },
  heart: { label: "Heart a lot you’d also like.", detail: "If your top lot gets away, Glim can move your money there." },
  bid: { label: "Bid, or let Glim bid" },
  close: { label: "Close bidding" },
  charge: { label: "Charge winners and see your receipt" },
};

const ORDER: readonly GuideStep[] = ["power", "heart", "bid", "close", "charge"];

export type GuideStepState = "done" | "now" | "next";

export interface GuideView {
  /** "Step 2 of 5": the step that is now, or the last one once every step is done. */
  position: number;
  total: number;
  steps: { key: GuideStep; number: number; label: string; detail: string | null; state: GuideStepState }[];
}

/**
 * The step after the furthest one done is now, so the guide never goes back: a guest who bids
 * before hearting a lot sees step 3 done and step 4 next, with step 2 left as it was.
 */
export function guideView(progress: GuideProgress): GuideView {
  const furthest = ORDER.reduce((last, step, index) => (progress[step] ? index : last), -1);
  const now = furthest + 1 < ORDER.length ? furthest + 1 : null;
  return {
    position: (now ?? ORDER.length - 1) + 1,
    total: ORDER.length,
    steps: ORDER.map((key, index) => ({
      key,
      number: index + 1,
      label: GUIDE_LABELS[key].label,
      // The second sentence is drawn on the step that is now.
      detail: index === now ? (GUIDE_LABELS[key].detail ?? null) : null,
      state: progress[key] ? "done" : index === now ? "now" : "next",
    })),
  };
}

/**
 * The step a new stream row completes for this paddle, if any. An organizer's stream also carries
 * every other paddle's hold rows, so private rows count only when they are this paddle's.
 */
export function stepDoneBy(row: StreamEvent, paddle: { paddleId: string; paddleNumber: number }): GuideStep | null {
  const own = row.paddleId === paddle.paddleId;
  switch (row.type) {
    case "hold":
      return own && row.payload.status === "authorized" ? "power" : null;
    case "bid":
      if (row.payload.kind === "favorite_changed") return own && row.payload.isFavorite ? "heart" : null;
      if (row.payload.kind === "bids_placed") {
        return row.payload.bids.some((bid) => bid.paddleNumber === paddle.paddleNumber) ? "bid" : null;
      }
      return null;
    case "glim":
      return own && row.payload.kind === "plan_status" && row.payload.status === "active" ? "bid" : null;
    case "event_status":
      if (row.payload.kind === "event_closed" || row.payload.kind === "event_settling") return "close";
      return row.payload.kind === "event_settled" ? "charge" : null;
    default:
      return null;
  }
}

/** Charging implies bidding closed, so a settled row marks both. */
export function withStepDone(progress: GuideProgress, step: GuideStep): GuideProgress {
  if (progress[step] && (step !== "charge" || progress.close)) return progress;
  return step === "charge" ? { ...progress, close: true, charge: true } : { ...progress, [step]: true };
}
