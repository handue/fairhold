/**
 * Asking PayPal before charging, as a reducer with no React, so the rail can never be left reading
 * "Checking…" after an answer came back.
 *
 * Each request gets an id, and only the latest one's answer is kept. Every answer is dispatched,
 * whatever became of the effect that sent it: the version before this one dropped an answer when its
 * effect was cleaned up mid-request (the page re-read the ledger and the phase or the checks moved
 * on), and nothing ever set "checking" back to false. A failed request is said too: "Checking…" was
 * also what an unanswerable request left behind, with nothing more to wait for.
 */
import type { SettlementChecks } from "@/server/settlement/types";

import type { ChecksRequest } from "./ledger-model";

export interface ChecksRequestState {
  /** The id of the newest request sent; only its answer counts. */
  latest: number;
  /** That request, while it has no answer yet. */
  waiting: boolean;
  failed: boolean;
  /** PayPal's answer to the latest request that got one. */
  checks: SettlementChecks | null;
  error: string | null;
}

export type ChecksRequestEvent =
  | { type: "sent"; id: number }
  | { type: "answered"; id: number; checks: SettlementChecks }
  | { type: "failed"; id: number; error: string; checks?: SettlementChecks };

export const NO_CHECKS_REQUEST: ChecksRequestState = { latest: 0, waiting: false, failed: false, checks: null, error: null };

export function reduceChecksRequest(state: ChecksRequestState, event: ChecksRequestEvent): ChecksRequestState {
  switch (event.type) {
    case "sent":
      return { ...state, latest: event.id, waiting: true, failed: false, error: null };
    case "answered":
      if (event.id !== state.latest) return state;
      return { ...state, waiting: false, failed: false, checks: event.checks, error: null };
    case "failed":
      if (event.id !== state.latest) return state;
      return { ...state, waiting: false, failed: true, checks: event.checks ?? state.checks, error: event.error };
  }
}

export function checksRequestStatus(state: ChecksRequestState): ChecksRequest {
  if (state.waiting) return "asking";
  return state.failed ? "failed" : "idle";
}
