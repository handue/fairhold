"use client";

import dynamic from "next/dynamic";
import { useRef, type ReactNode } from "react";

import type { InsightsView } from "@/server/settlement/types";
import { cn } from "@/ui/cn";
import { useLiveRefresh } from "@/ui/live/LiveStream";
import { Money } from "@/ui/Money";

import { OrganizerCorner } from "./OrganizerCorner";
import { CHART, insightsCopy, limitBarHeight, raisedChart, sparkline, topLotRows, type Kpi } from "./insights-model";
import { OrganizerNav } from "./OrganizerNav";
import type { TopLotsHandle } from "./TopLotsGrid";

/** The grid only exists in the browser; its frame holds the widget's height meanwhile. */
const TopLotsGrid = dynamic(() => import("./TopLotsGrid"), {
  ssr: false,
  loading: () => <div aria-busy="true" className="h-[285px] border-t border-line" />,
});

const MONO_CAPS = "font-mono text-11.5 leading-16 tracking-caps uppercase";
const WIDGET = "min-w-0 rounded-20 border border-line bg-white px-24 py-20";

/** Screen 28: "Tonight", the organizer's report, in 12's system on a twelve-track grid of widgets. */
export function InsightsScreen({ view, organizerName }: { view: InsightsView; organizerName: string }) {
  // Every row of the event can move a figure here, and the server reads them all afresh.
  useLiveRefresh(() => true);
  const grid = useRef<TopLotsHandle | null>(null);
  const copy = insightsCopy(view);
  const rows = topLotRows(view);

  return (
    <>
      <OrganizerNav event={view.event} organizerName={organizerName} active="insights" />

      <main className="mx-auto max-w-1344 px-48 pt-32 pb-116 tabular-nums">
        <div className="flex h-16 items-center justify-between">
          <span className={cn("text-muted", MONO_CAPS)}>
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
        <div className="mt-8 flex items-end justify-between">
          <h1 className="text-30 leading-40 font-semibold tracking-title">Tonight</h1>
          {copy.note && <p className="text-14 leading-24 whitespace-nowrap text-muted">{copy.note}</p>}
        </div>

        <div className="mt-20 grid grid-cols-12 gap-16">
          {copy.kpis.map((kpi, index) => (
            <KpiWidget key={kpi.label} kpi={kpi}>
              {index === 0 && <Sparkline view={view} />}
            </KpiWidget>
          ))}

          <section aria-label="Raised through the evening" className={cn(WIDGET, "col-span-8 flex h-300 flex-col")}>
            <p className="text-15 leading-20 font-semibold tracking-[-.005em]">Raised through the evening</p>
            <p className="mt-2 text-13 leading-18 whitespace-nowrap text-muted">Current high bids on every lot, from the open to the close</p>
            <RaisedChart view={view} />
          </section>

          <section aria-label="Limits kept" className="col-span-4 flex h-300 min-w-0 flex-col rounded-20 border border-ink bg-ink px-24 py-20 text-white">
            <span className={cn("block text-on-ink-muted", MONO_CAPS)}>Limits kept</span>
            <p className="mt-6 font-mono text-[44px] leading-48 font-medium tracking-display whitespace-nowrap">{copy.limits.figure}</p>
            <p className="text-13 leading-18 whitespace-nowrap text-on-ink-muted">{copy.limits.sub}</p>
            <div className="relative mt-14 min-h-0 flex-1" aria-hidden="true">
              <span className="absolute top-0 right-0 font-mono text-10.5 leading-13 tracking-label text-on-ink-muted uppercase">Limit</span>
              <div className="absolute top-15 right-0 left-0 h-1 bg-[rgba(255,255,255,.55)]" />
              <div className="absolute top-16 right-0 bottom-0 left-0 flex items-end gap-2">
                {view.limits.shares.map((share, index) => (
                  <i key={index} className="block flex-1 bg-lime" style={{ height: limitBarHeight(share) }} />
                ))}
              </div>
            </div>
            <p className="mt-12 text-13 leading-18 whitespace-nowrap">
              {copy.limits.foot.map((part, index) => (
                <span key={part}>
                  {index > 0 && <span className="text-on-ink-muted"> · </span>}
                  {part}
                </span>
              ))}
            </p>
          </section>

          <section aria-label="Top lots" className="col-span-8 h-339 min-w-0 overflow-hidden rounded-20 border border-line bg-white">
            <div className="flex h-52 items-center justify-between px-24">
              <p className="text-15 leading-20 font-semibold tracking-[-.005em]">Top lots</p>
              <p className="text-13 leading-18 whitespace-nowrap text-muted">{copy.topLots.note}</p>
            </div>
            <div className="border-t border-line">
              <TopLotsGrid rows={rows} amountHeader={copy.topLots.amountHeader} slug={view.event.slug} handleRef={grid} />
            </div>
          </section>

          <section aria-label="Hold utilization" className={cn(WIDGET, "col-span-4 flex h-339 flex-col")}>
            <span className={cn("block text-muted", MONO_CAPS)}>Hold utilization</span>
            <p className="mt-6 font-mono text-[44px] leading-48 font-medium tracking-display whitespace-nowrap">{copy.holds.figure}</p>
            <p className="mt-2 text-13 leading-18 whitespace-nowrap text-muted">{copy.holds.sub}</p>
            <div className="mt-14 flex h-80 items-stretch gap-4" aria-hidden="true">
              {view.holds.winnerShares.map((share, index) => (
                <span key={index} className="flex flex-1 flex-col justify-end gap-2">
                  <i className="block rounded-t-3 bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" style={{ height: `calc(${(1 - share) * 100}% - 1px)` }} />
                  <i className="block bg-ink" style={{ height: `calc(${share * 100}% - 1px)` }} />
                </span>
              ))}
            </div>
            {copy.holds.ends && (
              <p className="mt-6 flex justify-between font-mono text-11 leading-14 whitespace-nowrap text-muted">
                <span>{copy.holds.ends[0]}</span>
                <span>{copy.holds.ends[1]}</span>
              </p>
            )}
            <p className="mt-10 flex gap-14 text-12.5 leading-18 whitespace-nowrap text-ink2">
              <span className="inline-flex items-center gap-6">
                <i className="block size-10 rounded-3 bg-ink" />
                Charged
              </span>
              <span className="inline-flex items-center gap-6">
                <i className="block size-10 rounded-3 bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" />
                Released
              </span>
              <span className="text-muted">Each bar is one winner’s hold</span>
            </p>
            <p className="mt-auto border-t border-line pt-12 text-13 leading-18 text-ink2">{copy.holds.foot}</p>
          </section>
        </div>
      </main>

      <OrganizerCorner bubble={null} />
    </>
  );
}

function KpiWidget({ kpi, children }: { kpi: Kpi; children?: ReactNode }) {
  return (
    <section aria-label={kpi.label} className={cn(WIDGET, "relative col-span-3 flex h-116 flex-col")}>
      <span className={cn("block text-muted", MONO_CAPS)}>{kpi.label}</span>
      <p className="mt-6 font-mono text-[32px] leading-38 font-medium tracking-[-.03em] whitespace-nowrap">
        {kpi.cents === null ? kpi.value : <Money cents={kpi.cents} />}
        {kpi.of && (
          <>
            {" "}
            <em className="text-20 leading-none tracking-heading text-muted not-italic">{kpi.of}</em>
          </>
        )}
      </p>
      <p className="text-13 leading-18 whitespace-nowrap text-muted">{kpi.sub}</p>
      {children}
    </section>
  );
}

function Sparkline({ view }: { view: InsightsView }) {
  const spark = sparkline(view.raised, view.window);
  if (!spark) return null;
  return (
    <svg width="112" height="40" viewBox="0 0 112 40" fill="none" aria-hidden="true" className="absolute top-24 right-24">
      <path d={spark.path} stroke="var(--color-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={spark.end.x} cy={spark.end.y} r="3" fill="var(--color-ink)" />
    </svg>
  );
}

const MUTED = "var(--color-muted)";
const MONO_FONT = "var(--font-mono)";

function RaisedChart({ view }: { view: InsightsView }) {
  const chart = raisedChart(view.raised, view.window, view.event.timeZone);
  return (
    <svg width={CHART.width} height={CHART.height} viewBox={`0 0 ${CHART.width} ${CHART.height}`} fill="none" role="img" aria-label={chart.aria} className="mt-14 block overflow-visible">
      {chart.gridlines.map((gridline) => (
        <g key={gridline.label}>
          <path d={`M${CHART.left} ${gridline.y.toFixed(1)}H${CHART.right}`} stroke="var(--color-line)" />
          <text x="42" y={(gridline.y + 3.5).toFixed(1)} textAnchor="end" fontFamily={MONO_FONT} fontSize="11" fill={MUTED}>
            {gridline.label}
          </text>
        </g>
      ))}
      {chart.xLabels.map((label) => (
        <text key={`${label.text}-${label.x}`} x={label.x.toFixed(1)} y={label.y} textAnchor={label.anchor} fontFamily={MONO_FONT} fontSize="11" fill={MUTED}>
          {label.text}
        </text>
      ))}
      {chart.area && <path d={chart.area} fill="var(--color-ink)" fillOpacity=".05" />}
      {chart.line && <path d={chart.line} stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {chart.end && (
        <>
          <circle cx={chart.end.x.toFixed(1)} cy={chart.end.y.toFixed(1)} r="4" fill="var(--color-ink)" stroke="var(--color-white)" strokeWidth="2" />
          <text x={(chart.end.x + 10).toFixed(1)} y={(chart.end.y + 4).toFixed(1)} fontFamily={MONO_FONT} fontSize="13" fontWeight="500" fill="var(--color-ink)">
            {chart.end.label}
          </text>
        </>
      )}
    </svg>
  );
}
