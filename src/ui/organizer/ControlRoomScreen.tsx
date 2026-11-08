"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LedgerRow, LedgerView, SettlementChecks } from "@/server/settlement/types";
import { apiGet, apiPost, ApiClientError } from "@/ui/api";
import { cn } from "@/ui/cn";
import { useStreamEvent } from "@/ui/live/LiveStream";
import { Orb } from "@/ui/Orb";
import { PaddleMark } from "@/ui/PaddleMark";

import { canRetry, filterLabels, LEDGER_PAGE_SIZE, lotsTotalLabel, withoutBidsLine, type LedgerFilter } from "./ledger-model";
import type { LedgerGridHandle, LedgerPager } from "./LedgerGrid";
import { LedgerRail } from "./LedgerRail";
import { OrganizerNav } from "./OrganizerNav";

/** The grid only exists in the browser, and this page's first paint should not wait for its code. */
const LedgerGrid = dynamic(() => import("./LedgerGrid"), {
  ssr: false,
  loading: () => <div aria-busy="true" className="h-[574px] rounded-20 border border-line" />,
});

/** The stream brings changes at once; this catches what it missed and keeps the queue moving. */
const POLL_MS = { charging: 2_000, other: 10_000 } as const;
const STREAM_DEBOUNCE_MS = 200;

const FILTERS: readonly LedgerFilter[] = ["all", "winners", "nothing"];

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

/** Screen 12: the settlement ledger, the checks and the one action. */
export function ControlRoomScreen({ initial, organizerName }: { initial: LedgerView; organizerName: string }) {
  const [view, setView] = useState(initial);
  const [liveChecks, setLiveChecks] = useState<SettlementChecks | null>(null);
  const [checking, setChecking] = useState(initial.phase === "ready" && initial.checks.passed === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LedgerFilter>("all");
  const [search, setSearch] = useState("");
  const [pager, setPager] = useState<LedgerPager | null>(null);
  const grid = useRef<LedgerGridHandle | null>(null);

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

  const askPaypal = useCallback(
    () => apiPost<{ checks: SettlementChecks }>(`${path}/checks`).then(({ checks }) => checks),
    [path],
  );

  const checkAgain = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setLiveChecks(await askPaypal());
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setChecking(false);
    }
  }, [askPaypal]);

  // PayPal is asked once the page is on screen, not while it renders; simulated holds need no asking.
  const undecided = phase === "ready" && view.checks.passed === null;
  useEffect(() => {
    if (!undecided) return;
    let current = true;
    askPaypal().then(
      (checks) => {
        if (!current) return;
        setLiveChecks(checks);
        setChecking(false);
      },
      (failure: unknown) => {
        if (!current) return;
        setError(errorMessage(failure));
        setChecking(false);
      },
    );
    return () => {
      current = false;
    };
  }, [undecided, askPaypal]);

  // After settlement starts, its stored checks are the record.
  const checks = phase === "ready" ? (liveChecks ?? view.checks) : view.checks;

  const charge = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await apiPost<LedgerView>(path));
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiClientError && failure.code === "checks_failed") {
        const details = failure.details as { checks?: SettlementChecks } | null;
        if (details?.checks) setLiveChecks(details.checks);
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

  const onPager = useCallback((next: LedgerPager) => {
    setPager((current) =>
      current?.page === next.page && current.pages === next.pages && current.shown === next.shown && current.total === next.total
        ? current
        : next,
    );
  }, []);

  const totals = useMemo(() => totalsRow(view), [view]);
  const labels = filterLabels(phase);
  const counts: Record<LedgerFilter, number> = {
    all: view.counts.all,
    winners: view.counts.winners,
    nothing: view.counts.nonWinners,
  };
  const noBids = withoutBidsLine(view);
  const pages = Math.max(1, pager?.pages ?? 1);
  const page = pager?.page ?? 0;

  return (
    <>
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

            <div className="mt-16">
              <LedgerGrid
                rows={view.rows}
                totalsRow={totals}
                phase={phase}
                filter={filter}
                search={search}
                slug={view.event.slug}
                onRetry={retryItem}
                onPager={onPager}
                handleRef={grid}
              />
            </div>
          </section>

          <LedgerRail
            view={view}
            checks={checks}
            checking={checking}
            busy={busy}
            error={error}
            onCharge={charge}
            onRetryAll={retryAll}
            onCheckAgain={checkAgain}
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

      {phase === "ready" && checks.passed !== false ? (
        <OrganizerCorner title="Receipts are ready" body={"Every winner gets one when you charge."} />
      ) : (
        <OrganizerCorner />
      )}
    </>
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

/** Glim in the corner, as on 08. Organizers have no chat, so the orb only shows its bubble. */
function OrganizerCorner({ title, body }: { title?: string; body?: string }) {
  return (
    <div className="fixed right-32 bottom-28 z-40 flex items-end gap-12">
      {title && (
        <div className="max-w-230 rounded-18 rounded-br-4 border border-line bg-white px-14 py-12 shadow-bubble">
          <p className="text-13.5 font-semibold">{title}</p>
          <p className="mt-2 text-12.5 leading-[1.4] text-muted">{body}</p>
        </div>
      )}
      <Orb size={68} />
    </div>
  );
}
