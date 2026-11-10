"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";

import type { InsightsView } from "@/server/settlement/types";
import { cn } from "@/ui/cn";
import { useLiveRefresh } from "@/ui/live/LiveStream";
import { Money } from "@/ui/Money";

import { OrganizerCorner } from "./OrganizerCorner";
import { CHART, CHART_MIN_WIDTH, insightsCopy, limitBarHeight, raisedChart, sparkline, topLotRows, type Kpi } from "./insights-model";
import { OrganizerNav } from "./OrganizerNav";
import type { TopLotsHandle } from "./TopLotsGrid";

/** The grid only exists in the browser; its frame holds the widget's height meanwhile. */
const TopLotsGrid = dynamic(() => import("./TopLotsGrid"), {
  ssr: false,
  loading: () => <div aria-busy="true" className="h-[285px] border-t border-line" />,
});

const MONO_CAPS = "font-mono text-11.5 leading-16 tracking-caps uppercase";
const WIDGET = "min-w-0 rounded-20 border border-line bg-white px-24 py-20 max-md:px-20";

/**
 * Screen 28: "Tonight", the organizer's report, in 12's system on a twelve-track grid of widgets.
 * Below 1280 the four figures go two by two, and the chart and the lots take the full width, with
 * Limits kept and Hold utilization side by side between them (so Top lots shows every column without
 * scrolling from 768 up); on a phone it is one column.
 */
export function InsightsScreen({ view, organizerName }: { view: InsightsView; organizerName: string }) {
  // Every row of the event can move a figure here, and the server reads them all afresh.
  useLiveRefresh(() => true);
  const grid = useRef<TopLotsHandle | null>(null);
  const copy = insightsCopy(view);
  const rows = topLotRows(view);

  return (
    <>
      <OrganizerNav event={view.event} organizerName={organizerName} active="insights" />

      <main className="mx-auto max-w-1344 px-48 pt-32 pb-116 tabular-nums max-desk:px-32 max-desk:pb-0 max-md:px-16 max-md:pt-20">
        {/* On a phone the event line takes the full width, and Download CSV sits beside the title. */}
        <div className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-12 max-md:gap-y-8">
          <div className="flex h-16 items-center justify-between max-lg:gap-x-24 max-md:contents">
            <span className={cn("text-muted max-md:col-span-2 max-md:row-start-1", MONO_CAPS)}>
              {view.event.charityName} · <span className="max-md:whitespace-nowrap">{view.event.dateLabel}</span>
            </span>
            <button
              type="button"
              onClick={() => grid.current?.downloadCsv()}
              className="relative top-[-1px] my-[-8px] flex h-32 cursor-pointer items-center gap-8 text-14 font-medium whitespace-nowrap text-ink max-md:top-0 max-md:col-start-2 max-md:row-start-2 max-md:my-0 max-md:h-44 max-md:self-center"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
                <path d="M12 4v11" />
                <path d="M7 10l5 5 5-5" />
                <path d="M5 20h14" />
              </svg>
              Download CSV
            </button>
          </div>
          <div className="mt-8 flex items-end justify-between max-lg:gap-x-24 max-md:contents">
            <h1 className="text-30 leading-40 font-semibold tracking-title max-md:col-start-1 max-md:row-start-2 max-md:self-center">Tonight</h1>
            {copy.note && <p className="text-14 leading-24 whitespace-nowrap text-muted max-md:col-span-2 max-md:row-start-3 max-md:whitespace-normal">{copy.note}</p>}
          </div>
        </div>

        <div className="mt-20 grid grid-cols-12 gap-16 max-md:mt-16">
          {copy.kpis.map((kpi, index) => (
            <KpiWidget key={kpi.label} kpi={kpi}>
              {index === 0 && <Sparkline view={view} />}
            </KpiWidget>
          ))}

          <section aria-label="Raised through the evening" className={cn(WIDGET, "col-span-8 flex h-300 flex-col max-xl:col-span-12 max-md:h-auto")}>
            <p className="text-15 leading-20 font-semibold tracking-[-.005em]">Raised through the evening</p>
            <p className="mt-2 text-13 leading-18 whitespace-nowrap text-muted max-md:whitespace-normal">Current high bids on every lot, from the open to the close</p>
            <RaisedChart view={view} />
          </section>

          <section
            aria-label="Limits kept"
            className="col-span-4 flex h-300 min-w-0 flex-col rounded-20 border border-ink bg-ink px-24 py-20 text-white max-xl:col-span-6 max-xl:h-auto max-md:col-span-12 max-md:h-300 max-md:px-20"
          >
            <span className={cn("block text-on-ink-muted", MONO_CAPS)}>Limits kept</span>
            <p className="mt-6 font-mono text-[44px] leading-48 font-medium tracking-display whitespace-nowrap">{copy.limits.figure}</p>
            <p className="text-13 leading-18 whitespace-nowrap text-on-ink-muted max-md:whitespace-normal">{copy.limits.sub}</p>
            <div className="relative mt-14 min-h-0 flex-1" aria-hidden="true">
              <span className="absolute top-0 right-0 font-mono text-10.5 leading-13 tracking-label text-on-ink-muted uppercase">Limit</span>
              <div className="absolute top-15 right-0 left-0 h-1 bg-[rgba(255,255,255,.55)]" />
              <div className="absolute top-16 right-0 bottom-0 left-0 flex items-end gap-2">
                {view.limits.shares.map((share, index) => (
                  <i key={index} className="block flex-1 bg-lime" style={{ height: limitBarHeight(share) }} />
                ))}
              </div>
            </div>
            <p className="mt-12 text-13 leading-18 whitespace-nowrap max-md:whitespace-normal">
              {copy.limits.foot.map((part, index) => (
                <span key={part}>
                  {index > 0 && <span className="text-on-ink-muted"> · </span>}
                  {part}
                </span>
              ))}
            </p>
          </section>

          <section
            aria-label="Top lots"
            className="col-span-8 h-339 min-w-0 overflow-hidden rounded-20 border border-line bg-white max-desk:h-auto max-xl:order-1 max-xl:col-span-12"
          >
            <div className="flex h-52 items-center justify-between gap-x-16 px-24 max-md:px-20">
              <p className="text-15 leading-20 font-semibold tracking-[-.005em]">Top lots</p>
              <p className="text-13 leading-18 whitespace-nowrap text-muted">{copy.topLots.note}</p>
            </div>
            <div className="border-t border-line">
              <TopLotsGrid rows={rows} amountHeader={copy.topLots.amountHeader} slug={view.event.slug} handleRef={grid} />
            </div>
          </section>

          <section aria-label="Hold utilization" className={cn(WIDGET, "col-span-4 flex h-339 flex-col max-xl:col-span-6 max-xl:h-auto max-md:col-span-12")}>
            <span className={cn("block text-muted", MONO_CAPS)}>Hold utilization</span>
            <p className="mt-6 font-mono text-[44px] leading-48 font-medium tracking-display whitespace-nowrap">{copy.holds.figure}</p>
            <p className="mt-2 text-13 leading-18 whitespace-nowrap text-muted max-md:whitespace-normal">{copy.holds.sub}</p>
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
            <p className="mt-10 flex gap-14 text-12.5 leading-18 whitespace-nowrap text-ink2 max-desk:mb-16 max-desk:flex-wrap max-desk:gap-y-4">
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
    <section aria-label={kpi.label} className={cn(WIDGET, "relative col-span-3 flex h-116 flex-col max-xl:col-span-6 max-md:col-span-12")}>
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

/** How far from 778 the chart's frame may be and still draw the board's chart. */
const CHART_AS_DRAWN_SLACK = 4;
const MUTED = "var(--color-muted)";
const MONO_FONT = "var(--font-mono)";

function RaisedChart({ view }: { view: InsightsView }) {
  // The widget's inner width. At 1440 and above the board draws 778 in a frame 776.67 wide, so a
  // frame within a few pixels of that keeps the drawn chart; other widths redraw it at their own.
  const svg = useRef<SVGSVGElement | null>(null);
  const [width, setWidth] = useState<number>(CHART.width);
  useEffect(() => {
    const frame = svg.current?.parentElement;
    if (!frame) return;
    const observer = new ResizeObserver(([entry]) => {
      const inner = Math.floor(entry?.contentRect.width ?? CHART.width);
      setWidth(Math.abs(inner - CHART.width) <= CHART_AS_DRAWN_SLACK ? CHART.width : Math.max(CHART_MIN_WIDTH, inner));
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  const chart = raisedChart(view.raised, view.window, view.event.timeZone, width);
  return (
    <svg
      ref={svg}
      width={width}
      height={CHART.height}
      viewBox={`0 0 ${width} ${CHART.height}`}
      fill="none"
      role="img"
      aria-label={chart.aria}
      className="mt-14 block overflow-visible max-desk:max-w-full"
    >
      {chart.gridlines.map((gridline) => (
        <g key={gridline.label}>
          <path d={`M${CHART.left} ${gridline.y.toFixed(1)}H${chart.right}`} stroke="var(--color-line)" />
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
