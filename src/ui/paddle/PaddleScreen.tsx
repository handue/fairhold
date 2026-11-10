"use client";

import Link from "next/link";
import { useMemo } from "react";

import { buildPaddleView, changesPaddlePage, type PaddleLotRow, type PaddleSeed, type PaddleView } from "@/server/queries/paddle-view";

import { buttonClass } from "../Button";
import { CATEGORY_LABELS } from "../categories";
import { cn } from "../cn";
import { CornerOrb, GLIM_INVITATION } from "../CornerOrb";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import { EventNav } from "../EventNav";
import { Eyebrow } from "../Eyebrow";
import { formatBidCount, formatClockTime, formatLotNumber, formatPaddleNumber, formatUsd, keepTogether } from "../format";
import { ArrowRightIcon, LockIcon } from "../icons";
import { useLiveRecords, useLiveRefresh, useLiveServerNow } from "../live/LiveStream";
import { Money } from "../Money";
import { powerHref } from "../power/power-href";
import { catalogHref, lotHref, myPaddleHref, type GuestLinks } from "../routes";
import { ServerClockProvider } from "../ServerClock";
import { StatusPill } from "../StatusPill";

import { GlimActivity } from "./GlimActivity";
import { ArrowUpRightIcon, HeartLineIcon, SpinnerIcon } from "./icons";
import { RowTimer } from "./RowTimer";
import { lotClockTime } from "./time";

/** The stone tile of a row: 160 x 112 as drawn, narrower below 1280, and 96 x 72 on a phone. */
const TILE = "flex h-112 items-center justify-center overflow-hidden rounded-20 bg-stone-tile max-md:h-72 max-md:rounded-16";
/** The tile's 140 x 105 drawing (its line weight never scales), smaller with the tile. */
const DRAWING = "max-xl:h-90 max-xl:w-120 max-md:h-63 max-md:w-84 max-md:-top-2";
/** A row's second line: one line as drawn, and free to wrap where the column narrows. */
const NOTE = "mt-8 h-20 text-13 leading-20 whitespace-nowrap max-desk:h-auto max-desk:text-pretty max-desk:whitespace-normal";

/**
 * Screen 10, My paddle (mockups/10, design/23): the hold and what is in winning bids, the guest's
 * lots, and Glim's activity. Rows fold from the stream like 08's; Glim's plan and feed, a raise's
 * window and the close refresh the server's page.
 */
export function PaddleScreen({ seed, links }: { seed: PaddleSeed; links: GuestLinks }) {
  const records = useLiveRecords(seed);
  const view = useMemo(() => buildPaddleView(records), [records]);
  const serverNow = useLiveServerNow(seed.now);
  const paddleId = seed.paddle?.id ?? "";
  useLiveRefresh((row) => changesPaddlePage(row, paddleId));

  const idle = view.glim.duty.kind === "idle";
  return (
    <ServerClockProvider serverNow={serverNow}>
      <EventNav event={view.event} viewer={view.viewer} links={links} active="paddle" />

      <main className="mx-auto max-w-1344 px-48 pt-24 pb-120 tabular-nums max-desk:px-32 max-md:px-16 max-md:pt-16 max-md:pb-[calc(136px+env(safe-area-inset-bottom))]">
        <MoneyPanel view={view} links={links} />

        <div className="mt-32 grid grid-cols-[minmax(0,1fr)_416px] items-start gap-x-40 max-desk:gap-x-32 max-lg:grid-cols-1 max-lg:gap-y-32 max-md:mt-24 max-md:gap-y-24">
          <section aria-label="My lots">
            <div className="flex h-68 items-center justify-between border-b border-line max-md:h-auto max-md:flex-col max-md:items-start max-md:gap-6 max-md:pb-14">
              <h2 className="text-22 leading-28 font-semibold tracking-heading">My lots</h2>
              <p className="flex items-center gap-8 text-13.5 whitespace-nowrap text-muted max-md:items-start max-md:leading-20 max-md:text-balance max-md:whitespace-normal">
                <HeartLineIcon size={15} className="max-md:mt-3 max-md:flex-none" />
                Your winning bids support {view.event.charityName}
              </p>
            </div>
            {view.rows.length === 0 ? (
              <NoBidsRow paddleNumber={view.viewer.paddleNumber} links={links} />
            ) : (
              view.rows.map((row) => <LotRow key={row.number} row={row} links={links} timeZone={view.event.timeZone} />)
            )}
            <p className="mt-20 flex items-center gap-8 text-12.5 leading-18 text-ink2">
              <LockIcon size={15} />
              You pay only for the lots you win.
            </p>
          </section>

          <GlimActivity
            slug={links.slug}
            holdCents={view.money.holdCents}
            glim={view.glim}
            timeZone={view.event.timeZone}
            fitsOneRow={view.rows.length <= 1}
          />
        </div>
      </main>

      {/* 08's invitation until Glim is bidding; 10's nudges were cut (design/23). */}
      <CornerOrb bubble={idle ? GLIM_INVITATION : undefined} />
    </ServerClockProvider>
  );
}

function MoneyPanel({ view, links }: { view: PaddleView; links: GuestLinks }) {
  const { money } = view;
  const closes = formatClockTime(view.event.closesAt, view.event.timeZone);
  const nothing = money.inWinningCents === 0;
  const full = money.leftCents === 0;
  const raiseHref = powerHref(links, myPaddleHref(links));

  return (
    <section
      aria-label="Bidding power"
      className="flex h-112 items-center rounded-24 bg-surface px-24 max-xl:grid max-xl:h-auto max-xl:grid-cols-[minmax(0,1fr)_auto] max-xl:gap-x-24 max-xl:gap-y-20 max-xl:py-20 max-md:grid-cols-1 max-md:gap-y-16 max-md:px-20"
    >
      <div className="flex flex-none items-center gap-14 max-xl:col-[1/2] max-xl:row-[1/2]">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white">
          <LockIcon size={18} />
        </span>
        <div>
          <b className="block text-16 leading-22 font-semibold">
            <Money cents={money.holdCents} /> held with PayPal
          </b>
          <span className="mt-2 block text-13 leading-18 text-muted">Nothing is charged until bidding closes at {keepTogether(closes)}.</span>
        </div>
      </div>

      <span className="mx-32 h-72 w-1 flex-none bg-ink/10 max-desk:mx-24 max-xl:col-[1/-1] max-xl:row-[2/3] max-xl:mx-0 max-xl:h-1 max-xl:w-auto" />

      <div className="min-w-0 flex-1 max-xl:col-[1/-1] max-xl:row-[3/4]">
        <div className="flex h-22 items-baseline justify-between text-13 leading-22 whitespace-nowrap text-muted max-md:h-auto max-md:gap-x-12">
          <span>
            <b className="mr-6 font-mono text-16 font-medium text-ink">
              <Money cents={money.inWinningCents} />
            </b>
            in winning bids
          </span>
          <span className="max-md:min-w-0 max-md:text-right">
            <b className="mr-6 font-mono text-16 font-medium text-ink">
              <Money cents={money.leftCents} />
            </b>
            left
            {/* On a phone Glim's room goes under the amount, so the two amounts stay over their ends of the bar. */}
            {money.roomNote && (
              <>
                <span className="max-md:hidden"> · </span>
                <span className="max-md:block max-md:leading-18 max-md:whitespace-normal">{money.roomNote}</span>
              </>
            )}
          </span>
        </div>
        <div
          className="mt-8 flex h-10 gap-2"
          role="img"
          aria-label={`${formatUsd(money.inWinningCents)} in winning bids and ${formatUsd(money.leftCents)} left, of ${formatUsd(money.holdCents)} held`}
        >
          {!nothing && (
            <i className={cn("block h-full bg-ink", full ? "rounded-[5px]" : "rounded-l-[5px]")} style={{ flex: `${money.inWinningCents} 1 0` }} />
          )}
          {!full && (
            <i
              className={cn("block h-full bg-lime inset-ring inset-ring-lime-edge", nothing ? "rounded-[5px]" : "rounded-r-[5px]")}
              style={{ flex: `${money.leftCents} 1 0` }}
            />
          )}
        </div>
        <p className="mt-12 text-14 leading-20 whitespace-nowrap text-ink2 max-md:text-pretty max-md:whitespace-normal">
          {nothing ? (
            <>
              If bidding ended now, you’d pay nothing. <b className="font-semibold text-ink">All {formatUsd(money.holdCents)}</b> would
              be released.
            </>
          ) : full ? (
            <>
              If bidding ended now, you’d pay <b className="font-semibold text-ink">{formatUsd(money.inWinningCents)}</b>. Nothing would
              be released.
            </>
          ) : (
            <>
              If bidding ended now, you’d pay <b className="font-semibold text-ink">{formatUsd(money.inWinningCents)}</b>.{" "}
              <b className="font-semibold text-ink">{formatUsd(money.leftCents)}</b> would be released.
            </>
          )}
        </p>
      </div>

      <div className="ml-40 flex flex-none flex-col items-stretch max-desk:ml-24 max-xl:col-[2/3] max-xl:row-[1/2] max-xl:ml-0 max-md:col-[1/2] max-md:row-[4/5]">
        {money.raisePending ? (
          // design/20's "Waiting for PayPal": the raise is open in a PayPal window.
          <div
            role="status"
            className="flex h-48 items-center justify-between gap-10 rounded-16 bg-white pr-16 pl-20 text-15 font-semibold"
          >
            Finish in the PayPal window
            <SpinnerIcon size={20} className="animate-spin" />
          </div>
        ) : (
          <Link
            href={raiseHref}
            className={cn(
              "flex h-48 items-center justify-between gap-10 rounded-16 pr-16 pl-20 text-15 font-semibold text-ink",
              // design/23: Raise goes quiet until there are bids, and See the lots takes the lime.
              money.hasBids ? "bg-lime" : "bg-white inset-ring inset-ring-line",
            )}
          >
            Raise bidding power
            <ArrowUpRightIcon size={18} />
          </Link>
        )}
        <span className="mt-4 text-center text-12 leading-20 whitespace-nowrap text-muted">Approve another hold in a PayPal window</span>
      </div>
    </section>
  );
}

function NoBidsRow({ paddleNumber, links }: { paddleNumber: number; links: GuestLinks }) {
  return (
    <article className="grid grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-x-20 border-b border-line py-16 max-xl:grid-cols-[128px_minmax(0,1fr)] max-xl:gap-y-12 max-md:grid-cols-[96px_minmax(0,1fr)] max-md:gap-x-14 max-md:gap-y-16">
      <div className={cn(TILE, "max-xl:col-[1/2] max-xl:row-[1/3] max-md:row-[1/2]")}>
        <PaddleTileDrawing paddleNumber={paddleNumber} />
      </div>
      <div className="max-xl:col-[2/3] max-xl:row-[1/2]">
        <Eyebrow size="sm">Paddle {formatPaddleNumber(paddleNumber)}</Eyebrow>
        <h3 className="mt-6 text-16 leading-22 font-semibold tracking-snug whitespace-nowrap">No bids yet</h3>
        <p className={cn(NOTE, "text-ink2")}>Bid on a lot yourself, or let Glim bid for you.</p>
      </div>
      <Link
        href={catalogHref(links)}
        className={buttonClass({
          variant: "lime",
          size: 48,
          className: "min-w-176 justify-between max-xl:col-[2/3] max-xl:row-[2/3] max-xl:justify-self-start max-md:col-[1/3] max-md:justify-self-stretch",
        })}
      >
        See the lots
        <ArrowRightIcon size={18} />
      </Link>
    </article>
  );
}

/** design/23: Jamie's paddle waits on the tile, upright, with its number. */
function PaddleTileDrawing({ paddleNumber }: { paddleNumber: number }) {
  return (
    <svg
      width={140}
      height={105}
      viewBox="0 0 120 90"
      fill="none"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("relative -top-3 flex-none overflow-visible stroke-ink non-scaling-stroke", DRAWING)}
    >
      <rect x="37.15" y="11" width="45.7" height="38.6" rx="11.4" className="fill-lime" />
      <rect x="56.45" y="49" width="7.1" height="23" rx="2" className="fill-ink" stroke="none" />
      <text x="60" y="35" textAnchor="middle" fontSize="13.5" fontWeight="600" stroke="none" className="fill-ink font-mono">
        {formatPaddleNumber(paddleNumber)}
      </text>
      <path d="M14 72H106" />
      <path d="M28 78H92" opacity=".35" />
    </svg>
  );
}

function LotRow({ row, links, timeZone }: { row: PaddleLotRow; links: GuestLinks; timeZone: string }) {
  const drawing = row.coverDrawing && isDrawingKey(row.coverDrawing) ? row.coverDrawing : null;
  const open = row.status === "open";
  return (
    <article className="relative grid grid-cols-[160px_minmax(0,1fr)_214px_88px] items-center gap-x-20 border-b border-line py-16 max-xl:grid-cols-[128px_minmax(0,1fr)_auto] max-xl:gap-y-12 max-md:grid-cols-[96px_minmax(0,1fr)_auto] max-md:gap-x-14 max-md:gap-y-14">
      <div className={cn(TILE, "max-xl:col-[1/2] max-xl:row-[1/3] max-md:row-[1/2]")}>
        {drawing && <LotIllustration drawing={drawing} variant="tile" className={cn("relative -top-3", DRAWING, row.done && "opacity-50")} />}
      </div>
      <div className={cn("max-xl:col-[2/3] max-xl:row-[1/2] max-md:col-[2/4]", row.done && "text-muted")}>
        <Eyebrow size="sm">
          Lot {formatLotNumber(row.number)} · {CATEGORY_LABELS[row.category]}
        </Eyebrow>
        <h3 className="mt-6 text-16 leading-22 font-semibold tracking-snug whitespace-nowrap max-desk:text-balance max-desk:whitespace-normal">
          <Link href={lotHref(links, row.number)} className="after:absolute after:inset-0">
            {row.title}
          </Link>
        </h3>
        <p className={cn(NOTE, row.done ? "text-muted" : "text-ink2")}>
          {row.note.text}
          {row.note.amountCents !== null && (
            <>
              {" "}
              <b className={cn("font-mono font-medium", !row.done && "text-ink")}>
                <Money cents={row.note.amountCents} />
              </b>
            </>
          )}
          {row.note.tail && <span className="text-muted"> · {row.note.tail}</span>}
        </p>
      </div>
      <div className="flex items-center gap-8 max-xl:col-[2/3] max-xl:row-[2/3] max-md:col-[1/3] max-md:flex-wrap max-md:gap-y-6">
        <RowStatus row={row} timeZone={timeZone} />
        {open && <RowTimer closesAt={row.closesAt} />}
      </div>
      <div className="flex flex-col items-end text-right max-xl:col-[3/4] max-xl:row-[1/3] max-md:row-[2/3]">
        {row.done ? (
          <>
            <span className="text-15 leading-26 font-semibold whitespace-nowrap">No charge</span>
            {row.soldCents !== null && (
              <span className="mt-2 text-13 leading-18 whitespace-nowrap text-muted">Sold for {formatUsd(row.soldCents)}</span>
            )}
          </>
        ) : (
          <>
            <span className="font-mono text-20 leading-26 font-medium tracking-heading">
              <Money cents={row.priceCents} />
            </span>
            <span className="mt-2 text-13 leading-18 whitespace-nowrap text-muted">{formatBidCount(row.bidCount)}</span>
          </>
        )}
      </div>
    </article>
  );
}

function RowStatus({ row, timeZone }: { row: PaddleLotRow; timeZone: string }) {
  if (row.status === "closed") {
    const at = lotClockTime(row.closesAt, timeZone);
    return row.viewerStatus === "won" ? (
      <StatusPill status="winning" edge>
        Won at {at}
      </StatusPill>
    ) : (
      <StatusPill status="closed">Closed at {at}</StatusPill>
    );
  }
  if (row.viewerStatus === "winning") {
    return (
      <StatusPill status="winning" edge>
        You’re winning
      </StatusPill>
    );
  }
  if (row.viewerStatus === "outbid") return <StatusPill status="outbid">You’re outbid</StatusPill>;
  return null;
}
