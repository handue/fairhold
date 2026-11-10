"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { EventSummary, LotDetail } from "@/server/queries/types";

import { ApiClientError, apiPost } from "../api";
import { buttonClass } from "../Button";
import { cn } from "../cn";
import { Eyebrow } from "../Eyebrow";
import { formatBidCount, formatClockTime, formatClosedTime, formatPaddleNumber } from "../format";
import { openGlim } from "../glim-events";
import { ArrowRightIcon, ClockIcon, LockIcon } from "../icons";
import { Countdown } from "../LiveTime";
import { useLiveStream } from "../live/LiveStream";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { AlertIcon, NewWindowIcon, SpinnerIcon } from "../power/icons";
import { powerHrefForLot } from "../power/power-href";
import { joinHref, type GuestLinks } from "../routes";
import { StatusPill } from "../StatusPill";

import {
  bidAction,
  bidCardPhase,
  maxFieldDigits,
  maxFieldText,
  presetsLabel,
  refusalOf,
  priceLabel,
  trustLine,
  wonPaymentLine,
  type BidAction,
  type BidCardPhase,
  type CardRefusal,
  type PowerOnLot,
} from "./bid-card-state";
import { parseWholeDollars } from "./whole-dollars";

const presetClass = "flex h-46 cursor-pointer items-center justify-center rounded-12 border text-14 font-medium";
const CTA = "mt-12 justify-between";
/** design/20's button with nothing to do yet: the button's shape on the Surface, in muted type. */
const CTA_OFF =
  "mt-12 flex h-56 w-full items-center justify-between gap-10 rounded-16 bg-surface px-20 text-16 font-semibold whitespace-nowrap text-muted";
/** A bid that takes longer than this shows the spinner in place of its amount. */
const SPINNER_DELAY_MS = 300;

interface BidCardProps {
  lot: LotDetail;
  event: EventSummary;
  power: PowerOnLot;
  /** The paddle that bought the lot, once it closed sold; null when unknown. */
  soldTo: number | null;
  /** The viewer's paddle, for state 9's "Paddle 142 · You". */
  viewerPaddle: number | null;
  links: GuestLinks;
}

/** True once `pending` has lasted SPINNER_DELAY_MS, so a quick bid never flashes the spinner. */
function useSlow(pending: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setSlow(true), SPINNER_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setSlow(false);
    };
  }, [pending]);
  return slow;
}

/** 05's bid card, in each state design/19 draws: the current bid, the presets or Max…, and the one button. */
export function BidCard({ lot, event, power, soldTo, viewerPaddle, links }: BidCardProps) {
  const phase = bidCardPhase(lot, event.status);
  if (phase !== "open") {
    return <SettledBidCard lot={lot} event={event} phase={phase} soldTo={soldTo} viewerPaddle={viewerPaddle} />;
  }
  return <OpenBidCard lot={lot} power={power} links={links} eventStatus={event.status} />;
}

function OpenBidCard({
  lot,
  power,
  links,
  eventStatus,
}: Pick<BidCardProps, "lot" | "power" | "links"> & { eventStatus: EventSummary["status"] }) {
  const { slug } = links;
  const stream = useLiveStream();
  const [picked, setPicked] = useState<number | null>(null);
  const [maxOpen, setMaxOpen] = useState(false);
  const [maxDigits, setMaxDigits] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [refusal, setRefusal] = useState<CardRefusal | null>(null);
  const slow = useSlow(pending);

  // A pick stands while it is still on offer. When a rival's bid moves the presets past it, the card
  // falls back to the next minimum, never to a higher amount the guest did not choose.
  const amountCents = picked !== null && lot.presetCents.includes(picked) ? picked : lot.nextMinimumCents;
  const maxCents = parseWholeDollars(maxDigits);
  const action = bidAction({ lot, power, amountCents, max: maxOpen ? { maxCents } : null, refusal });
  const lotPath = `/api/events/${encodeURIComponent(slug)}/lots/${lot.number}`;

  function changeChoice(next: () => void) {
    next();
    setRefusal(null);
  }

  async function submit() {
    // A double click is one bid, even before the button has rendered as disabled.
    if (inFlight.current) return;
    if (action.kind === "set_max" && (action.maxCents === null || action.tooLow)) return;
    if (action.kind !== "place" && action.kind !== "set_max") return;
    inFlight.current = true;
    setPending(true);
    setRefusal(null);
    try {
      if (action.kind === "set_max") {
        await apiPost(`${lotPath}/max`, { maxCents: action.maxCents });
        setMaxOpen(false);
        setMaxDigits("");
      } else {
        await apiPost(`${lotPath}/bid`, { amountCents: action.amountCents });
        setPicked(null);
      }
      stream.pollNow();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.code === "not_joined") {
        window.location.assign(joinHref(slug, window.location.pathname));
        return;
      }
      setRefusal(refusalOf(failure));
      // A refusal usually means the page is behind: a rival bid, or the hold changed.
      stream.pollNow();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void submit();
  };

  // The guest's own max on this lot, once it stands: what it does, above the button (state 2's line).
  const standingMax = !maxOpen && action.kind === "place" ? power.limitHereCents : null;

  return (
    <section aria-label="Place a bid" className="mt-22 rounded-22 border border-line p-20">
      <PriceHeader
        label={priceLabel("open", lot.currentBidCents)}
        pill={
          lot.viewerStatus === "winning" ? (
            <StatusPill status="winning">You’re winning</StatusPill>
          ) : lot.viewerStatus === "outbid" ? (
            <StatusPill status="outbid">You’re outbid</StatusPill>
          ) : null
        }
        cents={lot.currentBidCents ?? lot.startingBidCents}
      >
        <span className="inline-flex items-center gap-6">{formatBidCount(lot.bidCount)}</span>
        <span className="inline-flex items-center gap-6">
          <ClockIcon size={14} />
          Closes in <Countdown closesAt={lot.closesAt} className="font-mono" />
        </span>
      </PriceHeader>

      <Eyebrow className="mt-20">{presetsLabel(lot.currentBidCents)}</Eyebrow>
      <div role="radiogroup" aria-label={presetsLabel(lot.currentBidCents)} className="mt-8 grid grid-cols-4 gap-8 font-mono">
        {lot.presetCents.map((cents) => {
          const selected = !maxOpen && cents === amountCents;
          return (
            <button
              key={cents}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() =>
                changeChoice(() => {
                  setPicked(cents);
                  setMaxOpen(false);
                })
              }
              className={cn(presetClass, selected ? "border-ink bg-ink text-white" : "border-line")}
            >
              <Money cents={cents} />
            </button>
          );
        })}
        <button
          type="button"
          role="radio"
          aria-checked={maxOpen}
          onClick={() => changeChoice(() => setMaxOpen(true))}
          className={cn(presetClass, "font-sans", maxOpen ? "border-ink bg-ink text-white" : "border-line")}
        >
          Max…
        </button>
      </div>

      {maxOpen && (
        <label className="mt-8 flex h-46 cursor-text items-center rounded-12 bg-white px-16 inset-ring-[1.5px] inset-ring-ink">
          <input
            aria-label="Your max"
            autoFocus
            inputMode="numeric"
            autoComplete="off"
            placeholder="$"
            value={maxFieldText(maxDigits)}
            onChange={(event) => changeChoice(() => setMaxDigits(maxFieldDigits(event.target.value)))}
            onKeyDown={submitOnEnter}
            className="min-w-0 flex-1 bg-transparent font-mono text-14 font-medium outline-none placeholder:text-muted"
          />
          <span className="ml-12 text-12.5 text-muted">Your max</span>
        </label>
      )}

      <ActionLines action={action} refusal={refusal} lot={lot} maxCents={maxCents} standingMax={standingMax} />
      <ActionButton action={action} links={links} lotNumber={lot.number} pending={pending} slow={slow} onSubmit={submit} />
      <TrustLine>{trustLine("open", action.kind, eventStatus)}</TrustLine>

      <button
        type="button"
        onClick={() => openGlim({ lotNumber: lot.number, prefill: `Bid on ${lot.shortTitle} for me, up to $` })}
        className="mt-18 flex w-full cursor-pointer items-center gap-10 border-t border-line pt-18 text-14 font-semibold"
      >
        <Orb size={26} glow="soft" />
        Let Glim bid on this lot
        <span aria-hidden="true" className="ml-auto font-medium text-muted">
          →
        </span>
      </button>
    </section>
  );
}

/** The figures, and the one line between the presets and the button that says what happens. */
function ActionLines({
  action,
  refusal,
  lot,
  maxCents,
  standingMax,
}: {
  action: BidAction;
  refusal: CardRefusal | null;
  lot: LotDetail;
  maxCents: number | null;
  standingMax: number | null;
}) {
  if (action.kind === "raise") {
    return (
      <div role="status" className="mt-12 rounded-16 bg-surface px-20 py-16">
        <p className="text-15 leading-22 font-semibold text-ink">
          This {action.subject} needs{" "}
          <span className="font-mono">
            <Money cents={action.neededCents} />
          </span>
        </p>
        <p className="mt-2 text-13 leading-18 text-muted">
          You have <Amount cents={action.availableCents} /> left of <Amount cents={action.holdCents} />.
        </p>
      </div>
    );
  }
  // A refusal the card has no state for (the next minimum moved, the lot closed): the server's sentence.
  if (refusal?.kind === "message") {
    return (
      <p role="alert" className="mt-12 flex items-center gap-6 text-13 leading-20 text-ink2">
        <AlertIcon />
        {refusal.message}
      </p>
    );
  }
  if (action.kind === "set_max") {
    if (action.tooLow) {
      return (
        <p role="alert" className="mt-12 flex items-center gap-6 text-13 leading-20 text-ink2">
          <AlertIcon />
          <span>
            Your max has to be at least <Amount cents={action.minimumCents} />.
          </span>
        </p>
      );
    }
    return <MaxLine raiseCents={lot.minRaiseCents} maxCents={maxCents} />;
  }
  if (standingMax !== null) return <MaxLine raiseCents={lot.minRaiseCents} maxCents={standingMax} />;
  return null;
}

/** State 2's line: what a max does. It stays while the max stands. */
function MaxLine({ raiseCents, maxCents }: { raiseCents: number; maxCents: number | null }) {
  return (
    <p className="mt-12 text-13 leading-20 whitespace-nowrap text-ink2">
      Outbid? Your bid goes <Amount cents={raiseCents} /> over theirs, automatically, up to{" "}
      {maxCents === null ? "your max" : <Amount cents={maxCents} />}.
    </p>
  );
}

function ActionButton({
  action,
  links,
  lotNumber,
  pending,
  slow,
  onSubmit,
}: {
  action: BidAction;
  links: GuestLinks;
  lotNumber: number;
  pending: boolean;
  slow: boolean;
  onSubmit: () => void;
}) {
  const lime = buttonClass({ variant: "lime", size: 56, fullWidth: true, className: CTA });
  switch (action.kind) {
    case "set_power":
      return (
        <Link href={powerHrefForLot(links, lotNumber)} className={lime}>
          <span>Set bidding power</span>
          <ArrowRightIcon size={18} />
        </Link>
      );
    case "raise":
      return (
        <Link href={powerHrefForLot(links, lotNumber, action.raiseToCents)} className={lime}>
          <span>Raise bidding power</span>
          <NewWindowIcon size={18} />
        </Link>
      );
    case "set_max": {
      const ready = action.maxCents !== null && !action.tooLow;
      return (
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || !ready}
          aria-busy={pending}
          className={ready ? lime : CTA_OFF}
        >
          <span>Set max bid</span>
          {/* Like design/20's button with nothing to hold, an amount that can't be set isn't named. */}
          <span className="font-mono">
            {slow ? <SpinnerIcon size={20} /> : ready && action.maxCents !== null && <Money cents={action.maxCents} />}
          </span>
        </button>
      );
    }
    case "place":
      return (
        <button type="button" onClick={onSubmit} disabled={pending} aria-busy={pending} className={lime}>
          <span>{action.label}</span>
          <span className="font-mono">{slow ? <SpinnerIcon size={20} /> : <Money cents={action.amountCents} />}</span>
        </button>
      );
  }
}

/** Before opening and after closing: no presets, and the button's slot becomes a quiet line (states 7 to 9). */
function SettledBidCard({
  lot,
  event,
  phase,
  soldTo,
  viewerPaddle,
}: Pick<BidCardProps, "lot" | "event" | "soldTo" | "viewerPaddle"> & { phase: Exclude<BidCardPhase, "open"> }) {
  const closedAt = formatClosedTime(lot.closesAt, event.timeZone);
  const bids = <span className="inline-flex items-center gap-6">{formatBidCount(lot.bidCount)}</span>;

  let pill: ReactNode = null;
  let sub: ReactNode;
  let result: ReactNode;
  switch (phase) {
    case "opens_soon":
      sub = (
        <>
          {bids}
          <span className="inline-flex items-center gap-6">
            <ClockIcon size={14} />
            Opens in <Countdown closesAt={event.opensAt} className="font-mono" />
          </span>
        </>
      );
      result = (
        <>
          <span>Bidding opens</span>
          <b className="font-semibold text-ink">{formatClockTime(event.opensAt, event.timeZone)}</b>
        </>
      );
      break;
    case "won":
      pill = (
        <StatusPill status="winning" edge>
          Won at {closedAt}
        </StatusPill>
      );
      sub = (
        <>
          {viewerPaddle !== null && (
            <span className="inline-flex items-center gap-8">
              <span className="font-mono">Paddle {formatPaddleNumber(viewerPaddle)}</span>
              <span className="rounded-8 bg-lime px-7 py-2 text-10.5 font-semibold text-ink">You</span>
            </span>
          )}
          {bids}
        </>
      );
      result = (
        <>
          <span>{wonPaymentLine(event.status, formatClockTime(event.closesAt, event.timeZone))}</span>
          <b className="font-mono text-16 font-semibold text-ink">
            <Money cents={lot.currentBidCents ?? lot.startingBidCents} />
          </b>
        </>
      );
      break;
    case "sold":
      pill = <StatusPill status="closed">Closed at {closedAt}</StatusPill>;
      sub = (
        <>
          <span className="inline-flex items-center gap-6">
            {soldTo === null ? (
              "Sold"
            ) : (
              <span>
                Sold to <span className="font-mono">Paddle {formatPaddleNumber(soldTo)}</span>
              </span>
            )}
          </span>
          {bids}
        </>
      );
      result = (
        <>
          <span>You didn’t win this lot</span>
          <b className="font-semibold text-ink">No charge</b>
        </>
      );
      break;
    case "unsold":
      pill = <StatusPill status="closed">Closed at {closedAt}</StatusPill>;
      sub = <span className="inline-flex items-center gap-6">No bids</span>;
      result = <span>This lot closed with no bids</span>;
      break;
  }

  return (
    <section aria-label="Place a bid" className="mt-22 rounded-22 border border-line p-20">
      <PriceHeader label={priceLabel(phase, lot.currentBidCents)} pill={pill} cents={lot.currentBidCents ?? lot.startingBidCents}>
        {sub}
      </PriceHeader>
      <div className="mt-20 flex h-56 items-center justify-between rounded-16 bg-surface px-20 text-15 font-medium whitespace-nowrap text-ink2">
        {result}
      </div>
      <TrustLine>{trustLine(phase, null, event.status)}</TrustLine>
    </section>
  );
}

/** The label and pill, the big amount, and the line under it. A row with no pill keeps the pill's 30px. */
function PriceHeader({ label, pill, cents, children }: { label: string; pill: ReactNode; cents: number; children: ReactNode }) {
  return (
    <>
      <div className="flex min-h-30 items-center justify-between">
        <Eyebrow>{label}</Eyebrow>
        {pill}
      </div>
      <p className="mt-12 font-mono text-56 leading-none font-medium tracking-display">
        <Money cents={cents} />
      </p>
      <div className="mt-12 flex h-17 items-center gap-16 text-13 text-ink2">{children}</div>
    </>
  );
}

function TrustLine({ children }: { children: ReactNode }) {
  return (
    <p className="mt-12 flex items-center gap-8 text-12.5 text-ink2">
      <LockIcon size={15} />
      {children}
    </p>
  );
}

/** An amount inside a sentence, as design/19 sets it: mono, medium, in ink. */
function Amount({ cents }: { cents: number }) {
  return (
    <b className="font-mono font-medium text-ink">
      <Money cents={cents} />
    </b>
  );
}
