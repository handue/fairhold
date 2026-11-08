"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useReducer, useRef } from "react";

import type { CreatedHold } from "@/server/holds/create";
import type { HoldStatus } from "@/server/paypal/hold-store";

import { ApiClientError, apiGet, apiPost } from "../api";
import { useLiveRefresh, useStreamEvent } from "../live/LiveStream";
import { joinHref } from "../routes";

import { holdFlowReducer, IDLE, watchedHoldId, type HoldFlowState } from "./hold-flow";
import {
  browserListenerHost,
  closeWindow,
  goToApproval,
  listenForPaypalWindow,
  openBlankWindow,
  type PopupLike,
} from "./hold-window";

/** The window's messages and the stream are immediate; this is for when neither gets through. */
const POLL_MS = 2_500;
/** About 20 minutes, so a forgotten tab stops asking and offers the button again. A late message still lands. */
const MAX_POLLS = 480;
/** Long enough to see the nav flip to the new bidding power. */
const RETURN_DELAY_MS = 1_200;
const UNREADABLE_MESSAGE = "Something went wrong. Please try again.";

export interface UseHoldWindowOptions {
  slug: string;
  /** Where the guest goes once the hold is approved: a page of this event. */
  returnHref: string;
}

export interface HoldWindow {
  state: HoldFlowState;
  /** Call it directly from the click: browsers allow the popup only there. */
  start(amountCents: number): void;
  /** Back to choosing an amount, after a canceled or failed window. */
  reset(): void;
}

/**
 * The PayPal window as a hook: opens it, follows it, refreshes the page's server components when a
 * hold lands so the nav's bidding power flips at once, and takes the guest back to bid. Its news
 * comes from the window itself, from the stream's hold rows and from polling the hold, whichever
 * arrives first; a webhook finishing the hold reaches it only through the last two.
 */
export function useHoldWindow({ slug, returnHref }: UseHoldWindowOptions): HoldWindow {
  const router = useRouter();
  const [state, dispatch] = useReducer(holdFlowReducer, IDLE);
  const popup = useRef<PopupLike | null>(null);
  const currentHoldId = useRef<string | null>(null);
  const holdsPath = `/api/holds/${encodeURIComponent(slug)}`;

  const start = useCallback(
    (amountCents: number) => {
      popup.current = openBlankWindow(window);
      currentHoldId.current = null;
      dispatch({ type: "start", amountCents });

      apiPost<CreatedHold>(holdsPath, { amountCents, next: returnHref }).then(
        ({ holdId, approvalUrl }) => {
          // Before the window moves, so its message can never arrive first.
          currentHoldId.current = holdId;
          const route = goToApproval(popup.current, approvalUrl, window);
          dispatch({ type: "created", holdId, approvalUrl, route });
        },
        (failure: unknown) => {
          closeWindow(popup.current);
          popup.current = null;
          if (failure instanceof ApiClientError && failure.code === "not_joined") {
            window.location.assign(joinHref(slug, `${window.location.pathname}${window.location.search}`));
            return;
          }
          dispatch({
            type: "create_failed",
            message: failure instanceof ApiClientError ? failure.message : UNREADABLE_MESSAGE,
          });
          // A refusal means the page's figures are out of date.
          router.refresh();
        },
      );
    },
    [holdsPath, returnHref, router, slug],
  );

  const reset = useCallback(() => {
    currentHoldId.current = null;
    dispatch({ type: "reset" });
  }, []);

  useEffect(
    () =>
      listenForPaypalWindow(browserListenerHost(window), (message) => {
        if (message.holdId !== null && message.holdId === currentHoldId.current) {
          dispatch({ type: "window_outcome", outcome: message.outcome });
        } else if (message.outcome === "approved") {
          // Another window of this guest, say from before a reload: still new bidding power.
          router.refresh();
        }
      }),
    [router],
  );

  useStreamEvent((row) => {
    if (row.type === "hold" && row.payload.holdId === currentHoldId.current) {
      dispatch({ type: "hold_status", status: row.payload.status });
    }
  });
  // A hold of this guest's landing anywhere changes the nav and what this page can offer, and so does
  // bidding closing or moving.
  useLiveRefresh((row) => row.type === "event_status" || (row.type === "hold" && row.payload.status !== "pending_approval"));

  const watched = watchedHoldId(state);
  useEffect(() => {
    if (watched === null) return;
    const controller = new AbortController();
    let polls = 0;
    const timer = setInterval(() => {
      polls += 1;
      if (polls > MAX_POLLS) {
        clearInterval(timer);
        dispatch({ type: "window_lost" });
        return;
      }
      apiGet<{ status: HoldStatus }>(`${holdsPath}/${encodeURIComponent(watched)}`, { signal: controller.signal }).then(
        ({ status }) => {
          dispatch({ type: "hold_status", status });
          // Checked only after the status, because the return page closes the window itself. A
          // window PayPal's pages cut off also reads closed, so this only lets the guest start over.
          if (status === "pending_approval" && popup.current?.closed) dispatch({ type: "window_lost" });
        },
        () => {
          // The next poll asks again.
        },
      );
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [holdsPath, watched]);

  const approved = state.phase === "approved";
  useEffect(() => {
    if (!approved) return;
    router.refresh();
    const leave = setTimeout(() => window.location.assign(returnHref), RETURN_DELAY_MS);
    return () => clearTimeout(leave);
  }, [approved, returnHref, router]);

  // A refused approval means the page's figures were out of date.
  const refused = state.phase === "refused";
  useEffect(() => {
    if (refused) router.refresh();
  }, [refused, router]);

  // Back from PayPal in the same tab can restore this page as it was left, mid-redirect.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      reset();
      router.refresh();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [reset, router]);

  return { state, start, reset };
}
