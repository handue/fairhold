"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";

import type { LedgerRow, LedgerView, SettlementChecks } from "@/server/settlement/types";
import { apiGet, apiPost, ApiClientError } from "@/ui/api";
import { cn } from "@/ui/cn";
import { useLiveServerNow, useStreamEvent } from "@/ui/live/LiveStream";
import { PaddleMark } from "@/ui/PaddleMark";
import { ServerClockProvider } from "@/ui/ServerClock";

import { checksRequestStatus, NO_CHECKS_REQUEST, reduceChecksRequest } from "./checks-request";
import {
  canRetry,
  cornerBubble,
  filterLabels,
  flaggedPaddles,
  LEDGER_PAGE_SIZE,
  lotsTotalLabel,
  railCopy,
  railFoot,
  railSection,
  transactionLine,
  withoutBidsLine,
  type FootAction,
  type LedgerFilter,
} from "./ledger-model";
import type { LedgerGridHandle, LedgerPager } from "./LedgerGrid";
import { LedgerRail } from "./LedgerRail";
import { OrganizerCorner } from "./OrganizerCorner";
import { OrganizerNav } from "./OrganizerNav";

/** The grid only exists in the browser, and this page's first paint should not wait for its code. */
const LedgerGrid = dynamic(() => import("./LedgerGrid"), {
  ssr: false,
  loading: () => <div aria-busy="true" className="h-[574px] rounded-20 border border-line" />,
});

/** The stream brings changes at once; this catches what it missed and keeps the queue moving. */
const POLL_MS = { charging: 2_000, other: 10_000 } as const;
const STREAM_DEBOUNCE_MS = 200;
/** PayPal is read four holds at a time; past this the rail stops saying "Checking…" and offers Check again. */
const CHECKS_TIMEOUT_MS = 45_000;

const FILTERS: readonly LedgerFilter[] = ["all", "winners", "nothing"];

/**
 * The ledger's body is 480px, ten rows, and everything else above the rail's bottom edge is 178px:
 * the event line, the head and the gap under it (84) and the grid's header, totals and borders (94).
 */
const LEDGER_BODY_MIN = 480;
const LEDGER_CHROME = 178;
/** The rail's flexible gap never goes below this. */
const RAIL_SPACER_MIN = 16;

function totalsRow(view: LedgerView): LedgerRow {
  return {
    paddleId: "ledger-total",
    paddleNumber: 0,
    bidder: "",
    lotsWon: lotsTotalLabel(view),
    lotsWonFull: "",
    glim: false,
    holdKind: null,
    heldCents: view.totals.heldCents,
    toChargeCents: view.totals.toChargeCents,
    toReleaseCents: view.totals.toReleaseCents,
    item: null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof ApiClientError ? error.message : "Something went wrong. Please try again.";
}

interface ControlRoomScreenProps {
  initial: LedgerView;
  organizerName: string;
  /** The organizer's own receipt in a demo, where they are also a guest; null hides the link. */
  receiptHref?: string | null;
  /** The organizer's own paddle, whose transaction ID the rail shows first. */
  ownPaddle?: number | null;
}

/** Screen 12: the settlement ledger, the checks and the one action, in every state of design/24. */
export function ControlRoomScreen({ initial, organizerName, receiptHref = null, ownPaddle = null }: ControlRoomScreenProps) {
  const [view, setView] = useState(initial);
  const [request, dispatch] = useReducer(reduceChecksRequest, NO_CHECKS_REQUEST);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [search, setSearch] = useState("");
  const [pager, setPager] = useState<LedgerPager | null>(null);
  const [bodyMin, setBodyMin] = useState(LEDGER_BODY_MIN);
  const grid = useRef<LedgerGridHandle | null>(null);
  const requests = useRef(0);
  const serverNow = useLiveServerNow(initial.now);

  const path = `/api/events/${encodeURIComponent(view.event.slug)}/settlement`;

  const refresh = useCallback(async () => {
    try {
      setView(await apiGet<LedgerView>(path));
    } catch {
      // The next poll or stream row tries again; a failed read changes nothing on screen.
    }
  }, [path]);

  // Hold, bid, close and settlement rows all move this page's figures.
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useStreamEvent(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void refresh(), STREAM_DEBOUNCE_MS);
  });
  useEffect(() => () => clearTimeout(debounce.current), []);

  const { phase } = view;
  useEffect(() => {
    if (phase === "charged" || phase === "ended") return;
    const timer = setInterval(() => void refresh(), phase === "charging" ? POLL_MS.charging : POLL_MS.other);
    return () => clearInterval(timer);
  }, [phase, refresh]);

  /** Asks PayPal about every real hold. Every answer is dispatched, and only the latest one counts. */
  const askPaypal = useCallback(() => {
    requests.current += 1;
    const id = requests.current;
    dispatch({ type: "sent", id });
    // A request that never answers would also leave "Checking…" up for good, so it gives up in time.
    apiPost<{ checks: SettlementChecks }>(`${path}/checks`, {}, { signal: AbortSignal.timeout(CHECKS_TIMEOUT_MS) }).then(
      ({ checks }) => dispatch({ type: "answered", id, checks }),
      (failure: unknown) => dispatch({ type: "failed", id, error: errorMessage(failure) }),
    );
  }, [path]);

  // PayPal is asked once the page is on screen, not while it renders; simulated holds need no asking.
  const undecided = phase === "ready" && view.checks.passed === null;
  useEffect(() => {
    if (undecided) askPaypal();
  }, [undecided, askPaypal]);

  const requestStatus = checksRequestStatus(request);
  // After settlement starts, its stored checks are the record.
  const checks = phase === "ready" ? (request.checks ?? view.checks) : view.checks;

  const charge = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await apiPost<LedgerView>(path));
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiClientError && failure.code === "checks_failed") {
        const details = failure.details as { checks?: SettlementChecks } | null;
        if (details?.checks) {
          requests.current += 1;
          dispatch({ type: "sent", id: requests.current });
          dispatch({ type: "answered", id: requests.current, checks: details.checks });
        }
      }
    } finally {
      setBusy(false);
    }
  }, [path]);

  const retryItem = useCallback(
    async (itemId: string) => {
      setError(null);
      try {
        setView(await apiPost<LedgerView>(`${path}/items/${encodeURIComponent(itemId)}/retry`));
      } catch (failure) {
        setError(errorMessage(failure));
      }
    },
    [path],
  );

  const retryAll = useCallback(async () => {
    setBusy(true);
    for (const row of view.rows) {
      if (row.item && canRetry(row.item)) await retryItem(row.item.id);
    }
    setBusy(false);
  }, [retryItem, view.rows]);

  /** Close bidding now: the demo control, kept on the rail as well as in 18's menu (C3). */
  const closeBidding = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/events/${encodeURIComponent(view.event.slug)}/demo/close-bidding`);
      await refresh();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }, [refresh, view.event.slug]);

  const onAction = useCallback(
    (action: FootAction) => {
      if (busy) return;
      if (action === "close") void closeBidding();
      else if (action === "check") {
        setError(null);
        askPaypal();
      } else if (action === "charge") void charge();
      else if (action === "retry") void retryAll();
    },
    [askPaypal, busy, charge, closeBidding, retryAll],
  );

  const onPager = useCallback((next: LedgerPager) => {
    setPager((current) =>
      current?.page === next.page && current.pages === next.pages && current.shown === next.shown && current.total === next.total
        ? current
        : next,
    );
  }, []);

  // A rail with more to say than 12's (21's V6 row, a failed check) keeps the ledger as tall as it
  // is, so the rail never runs past the grid (C4). Measured without the rail's flexible gap, which
  // only fills the height the grid gives it.
  const railSpacer = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const spacer = railSpacer.current;
    const rail = spacer?.parentElement;
    if (!spacer || !rail) return;
    const measure = () => {
      const natural = rail.offsetHeight - spacer.offsetHeight + RAIL_SPACER_MIN;
      setBodyMin(Math.max(LEDGER_BODY_MIN, Math.ceil(natural - LEDGER_CHROME)));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    observer.observe(spacer);
    measure();
    return () => observer.disconnect();
  }, []);

  const totals = useMemo(() => totalsRow(view), [view]);
  const flagged = useMemo(() => (phase === "ready" ? flaggedPaddles(checks) : new Map<number, string>()), [phase, checks]);
  const labels = filterLabels(phase);
  const counts: Record<LedgerFilter, number> = {
    all: view.counts.all,
    winners: view.counts.winners,
    nothing: view.counts.nonWinners,
  };
  const noBids = withoutBidsLine(view);
  const pages = Math.max(1, pager?.pages ?? 1);
  const page = pager?.page ?? 0;
  const bubble = cornerBubble(view, checks);
  const foot = railFoot(view, checks, { request: requestStatus, busy, receiptHref });

  return (
    <ServerClockProvider serverNow={serverNow}>
      <OrganizerNav event={view.event} organizerName={organizerName} />

      <main className="mx-auto max-w-1344 px-48 pt-32 tabular-nums">
        <div className="grid grid-cols-[minmax(0,1fr)_416px] items-stretch gap-x-40">
          <section aria-label="Settlement ledger" className="min-w-0">
            <div className="flex h-16 items-center justify-between">
              <span className="font-mono text-11.5 tracking-caps text-muted uppercase">
                {view.event.charityName} · {view.event.dateLabel}
              </span>
              <button
                type="button"
                onClick={() => grid.current?.downloadCsv()}
                className="relative top-[-1px] my-[-8px] flex h-32 cursor-pointer items-center gap-8 text-14 font-medium whitespace-nowrap text-ink"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
                  <path d="M12 4v11" />
                  <path d="M7 10l5 5 5-5" />
                  <path d="M5 20h14" />
                </svg>
                Download CSV
              </button>
            </div>

            <div className="mt-12 flex h-40 items-center justify-between">
              <div className="flex items-center gap-24">
                <h2 className="text-20 leading-28 font-semibold tracking-heading whitespace-nowrap">Settlement ledger</h2>
                <div role="tablist" aria-label="Show bidders" className="flex gap-2 rounded-20 bg-surface p-4">
                  {FILTERS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={filter === key}
                      onClick={() => setFilter(key)}
                      className={cn(
                        "flex h-32 cursor-pointer items-center gap-8 rounded-16 px-16 text-14 font-medium whitespace-nowrap",
                        filter === key ? "bg-ink text-white" : "text-ink2",
                      )}
                    >
                      {labels[key]}
                      <span className={cn("font-mono text-12", filter === key ? "text-on-ink-muted" : "text-muted")}>{counts[key]}</span>
                    </button>
                  ))}
                </div>
              </div>
              <label className="flex h-40 w-240 items-center gap-10 overflow-hidden rounded-20 border border-line pr-16 pl-14 text-14 whitespace-nowrap text-muted">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="flex-none">
                  <circle cx="11" cy="11" r="6.5" />
                  <path d="M16 16l4 4" />
                </svg>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search bidders or lots"
                  aria-label="Search bidders or lots"
                  className="w-full min-w-0 bg-transparent text-ink outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
                />
              </label>
            </div>

            <div className="mt-16" style={{ "--ledger-body-min": `${bodyMin}px` } as CSSProperties}>
              <LedgerGrid
                rows={view.rows}
                totalsRow={totals}
                phase={phase}
                filter={filter}
                search={search}
                slug={view.event.slug}
                flagged={flagged}
                onRetry={retryItem}
                onPager={onPager}
                handleRef={grid}
              />
            </div>
          </section>

          <LedgerRail
            copy={railCopy({ ...view, checks })}
            section={railSection(view, checks, requestStatus)}
            foot={foot}
            transaction={transactionLine(view, ownPaddle)}
            receiptHref={receiptHref}
            error={error ?? (phase === "ready" ? request.error : null)}
            onAction={onAction}
            spacerRef={(element) => {
              railSpacer.current = element;
            }}
          />
        </div>

        {/* The grid's pagination, rebuilt quietly from its API, and the lots that did not sell. */}
        <div className="mt-12 flex h-28 w-[calc(100%-456px)] items-center text-12.5 whitespace-nowrap text-muted">
          <span>
            Showing {pager?.shown ?? Math.min(LEDGER_PAGE_SIZE, view.counts.all)} of {pager?.total ?? view.counts.all}
          </span>
          {noBids && (
            <span className="ml-24 flex items-center gap-8">
              <PaddleMark tone="closed" size={14} />
              {noBids}
            </span>
          )}
          <span className="ml-auto flex items-center gap-6">
            <PagerButton label="Previous page" disabled={page <= 0} onClick={() => grid.current?.previous()} direction="previous" />
            <span className="mx-4">
              Page {page + 1} of {pages}
            </span>
            <PagerButton label="Next page" disabled={page >= pages - 1} onClick={() => grid.current?.next()} direction="next" />
          </span>
        </div>
      </main>

      <OrganizerCorner bubble={bubble} />
    </ServerClockProvider>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  direction,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  direction: "previous" | "next";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-28 cursor-pointer items-center justify-center rounded-full border border-line text-ink disabled:cursor-default disabled:opacity-45"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={direction === "previous" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}
