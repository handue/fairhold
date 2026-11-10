"use client";

import { useCallback, useMemo } from "react";

import type { AutopilotCardView, AutopilotRaiseCardView } from "@/server/chat/types";
import type { CreatedHold } from "@/server/holds/create";

import { apiPost } from "../api";
import { cn } from "../cn";
import { holdFlowCopy, type HoldNotice } from "../power/hold-flow";
import { useHoldWindow } from "../power/useHoldWindow";

import { EventChip, EventFrame, HeldNote } from "./cards";
import { ArrowUpRight, LockMark } from "./marks";

/** 10's ghost button at 07's size. */
const GHOST = "inline-flex h-36 cursor-pointer items-center gap-6 rounded-18 px-11 text-13.5 font-medium whitespace-nowrap text-ink disabled:cursor-default disabled:opacity-60";

/**
 * V2 (design/21 #5–#8): what Glim did on its own. Code wrote the trigger and "what" lines from the
 * engine's result; the muted why is Claude's, or a template. Skip ends Glim's bidding on the lot it
 * added; bids already placed stand.
 */
export function AutopilotCardView({ card, busy, onSkip }: { card: AutopilotCardView; busy: boolean; onSkip(lotNumber: number): void }) {
  const skip = card.skip && card.skipLotNumber !== null ? { label: card.skip.label, lotNumber: card.skipLotNumber } : null;
  return (
    <EventFrame
      eyebrow={card.eyebrow}
      card="autopilot"
      footer={
        <div className="col-span-2 mt-2 grid grid-cols-[26px_minmax(0,1fr)] items-center gap-x-10 gap-y-2 border-t border-line pt-10">
          <LockMark className="justify-self-center" />
          <span className="text-11.5 leading-16 text-ink2">{card.rulesLine}</span>
          {skip && (
            <button type="button" disabled={busy} onClick={() => onSkip(skip.lotNumber)} className={cn(GHOST, "col-start-2 -mr-11 justify-self-end")}>
              {skip.label}
            </button>
          )}
        </div>
      }
    >
      {card.triggerLine && <p className="mt-2 text-13.5 leading-[1.45] font-semibold">{card.triggerLine}</p>}
      <p className="mt-2 text-13.5 leading-[1.45]">{card.whatLine}</p>
      <p className="mt-4 text-13.5 leading-[1.45] text-muted">{card.whyLine}</p>
      {card.chip && <EventChip chip={card.chip} />}
    </EventFrame>
  );
}

/** 09's notice as one line in the card's note: "Canceled in PayPal. Nothing was held." */
function noticeLine(notice: HoldNotice): string {
  const title = /[.!?]$/.test(notice.title) ? notice.title : `${notice.title}.`;
  return notice.body ? `${title} ${notice.body}` : title;
}

const ENDED = "flex h-40 flex-1 items-center justify-center rounded-12 bg-surface text-13.5 font-semibold text-muted";

/**
 * V3 (design/21 #9, #10): the raise Glim prepared, only when the budget the guest named is above the
 * hold. Approving opens PayPal for the amount stored on the offer; "Not now" ends it.
 */
export function AutopilotRaiseCardView(props: {
  card: AutopilotRaiseCardView;
  slug: string;
  returnHref: string;
  busy: boolean;
  onDismiss(actionId: string): void;
}) {
  const { card } = props;
  return (
    <EventFrame eyebrow={card.eyebrow} card="autopilot_raise">
      <p className="mt-2 text-13.5 leading-[1.45]">{card.askLine}</p>
      <p className="mt-4 text-13.5 leading-[1.45] text-muted">{card.whyLine}</p>
      {card.ended ? (
        <div className="mt-12 flex gap-6">
          <span aria-disabled="true" className={ENDED}>
            {card.endedLabel}
          </span>
        </div>
      ) : (
        <OpenRaise {...props} />
      )}
    </EventFrame>
  );
}

function OpenRaise({ card, slug, returnHref, busy, onDismiss }: Parameters<typeof AutopilotRaiseCardView>[0]) {
  const path = `/api/glim/${encodeURIComponent(slug)}/raises/${encodeURIComponent(card.actionId)}`;
  // The route reads the amount from the stored offer; what goes from here is only where to come back to.
  const create = useCallback(({ next }: { amountCents: number; next: string }) => apiPost<CreatedHold>(path, { next }), [path]);
  const holdWindow = useHoldWindow({ slug, returnHref, create, stayOnApproval: true });
  const copy = useMemo(() => holdFlowCopy(holdWindow.state, card.amountCents), [holdWindow.state, card.amountCents]);
  const idle = holdWindow.state.phase === "idle";
  const label = copy.buttonEnabled ? card.approveLabel : copy.button;
  return (
    <>
      <div className="mt-12 flex gap-6">
        <button
          type="button"
          disabled={!copy.buttonEnabled || busy}
          onClick={() => holdWindow.start(card.amountCents)}
          className="flex h-40 flex-1 cursor-pointer items-center justify-center gap-6 rounded-12 bg-lime text-13.5 font-semibold text-ink disabled:cursor-default"
        >
          {label}
          {copy.buttonEnabled && <ArrowUpRight />}
        </button>
        {idle && (
          <button type="button" disabled={busy} onClick={() => onDismiss(card.actionId)} className={cn(GHOST, "h-40 rounded-12 px-12")}>
            {card.dismissLabel}
          </button>
        )}
      </div>
      <HeldNote>{copy.notice ? noticeLine(copy.notice) : card.note}</HeldNote>
    </>
  );
}
