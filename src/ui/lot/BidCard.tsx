"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";

import type { LotDetail } from "@/server/queries/types";

import { ApiClientError, apiPost } from "../api";
import { buttonClass } from "../Button";
import { cn } from "../cn";
import { Eyebrow } from "../Eyebrow";
import { formatBidCount, formatClockTime, formatUsd } from "../format";
import { openGlim } from "../glim-events";
import { ClockIcon, LockIcon } from "../icons";
import { Countdown } from "../LiveTime";
import { useLiveStream } from "../live/LiveStream";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { powerHrefForLot } from "../power/power-href";
import { joinHref, type GuestLinks } from "../routes";
import { StatusPill } from "../StatusPill";

import { parseWholeDollars } from "./whole-dollars";

const presetClass = "flex h-46 cursor-pointer items-center justify-center rounded-12 border text-14 font-medium";

interface BidCardProps {
  lot: LotDetail;
  links: GuestLinks;
  timeZone: string;
}

/** A plain line under the button: what the server said, and the one thing to do about it. */
interface Notice {
  message: string;
  link?: { href: string; label: string };
}

/** What a refusal adds to the server's sentence. Both lead to 09, which comes back to this lot. */
function noticeFor(failure: ApiClientError, links: GuestLinks, lotNumber: number): Notice {
  const href = powerHrefForLot(links, lotNumber);
  if (failure.code === "no_hold") return { message: failure.message, link: { href, label: "Set bidding power" } };
  if (failure.code === "over_bidding_power") {
    return { message: failure.message, link: { href, label: "Raise bidding power" } };
  }
  return { message: failure.message };
}

/** 05's bid card: the current bid and countdown, "Raise to" presets, Place bid and the agent link. */
export function BidCard({ lot, links, timeZone }: BidCardProps) {
  const { slug } = links;
  const stream = useLiveStream();
  const [picked, setPicked] = useState<number | null>(null);
  const [maxOpen, setMaxOpen] = useState(false);
  const [maxText, setMaxText] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // A pick stands while it is still on offer. When a rival's bid moves the presets past it, the card
  // falls back to the next minimum, never to a higher amount the guest did not choose.
  const amountCents = picked !== null && lot.presetCents.includes(picked) ? picked : lot.nextMinimumCents;
  const maxCents = parseWholeDollars(maxText);
  const lotPath = `/api/events/${encodeURIComponent(slug)}/lots/${lot.number}`;

  async function submit() {
    // A double click is one bid, even before the button has rendered as disabled.
    if (inFlight.current) return;
    if (maxOpen && maxCents === null) {
      setNotice({ message: "Enter your max in whole dollars." });
      return;
    }
    inFlight.current = true;
    setPending(true);
    setNotice(null);
    try {
      if (maxOpen && maxCents !== null) {
        await apiPost(`${lotPath}/max`, { maxCents });
        setMaxOpen(false);
        setMaxText("");
        setNotice({ message: `Your max on this lot is ${formatUsd(maxCents)}.` });
      } else {
        await apiPost(`${lotPath}/bid`, { amountCents });
        setPicked(null);
      }
      stream.pollNow();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.code === "not_joined") {
        window.location.assign(joinHref(slug, window.location.pathname));
        return;
      }
      setNotice(
        failure instanceof ApiClientError
          ? noticeFor(failure, links, lot.number)
          : { message: "Something went wrong. Please try again." },
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void submit();
  };

  if (lot.status === "closed") return <ClosedBidCard lot={lot} timeZone={timeZone} />;

  return (
    <section aria-label="Place a bid" className="mt-22 rounded-22 border border-line p-20">
      <div className="flex items-center justify-between">
        <Eyebrow>{lot.currentBidCents === null ? "Starting bid" : "Current bid"}</Eyebrow>
        {lot.viewerStatus === "winning" && <StatusPill status="winning">You’re winning</StatusPill>}
        {lot.viewerStatus === "outbid" && <StatusPill status="outbid">You’re outbid</StatusPill>}
      </div>
      <p className="mt-12 font-mono text-56 leading-none font-medium tracking-display">
        <Money cents={lot.currentBidCents ?? lot.startingBidCents} />
      </p>
      <div className="mt-12 flex gap-16 text-13 text-ink2">
        <span className="inline-flex items-center gap-6">{formatBidCount(lot.bidCount)}</span>
        <span className="inline-flex items-center gap-6">
          <ClockIcon size={14} />
          Closes in <Countdown closesAt={lot.closesAt} className="font-mono" />
        </span>
      </div>

      <Eyebrow className="mt-20">Raise to</Eyebrow>
      <div role="radiogroup" aria-label="Raise to" className="mt-8 grid grid-cols-4 gap-8 font-mono">
        {lot.presetCents.map((cents) => {
          const selected = !maxOpen && cents === amountCents;
          return (
            <button
              key={cents}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => {
                setPicked(cents);
                setMaxOpen(false);
                setNotice(null);
              }}
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
          onClick={() => {
            setMaxOpen(true);
            setNotice(null);
          }}
          className={cn(presetClass, "font-sans", maxOpen ? "border-ink bg-ink text-white" : "border-line")}
        >
          Max…
        </button>
      </div>

      {maxOpen && (
        <input
          aria-label="Your max"
          autoFocus
          inputMode="numeric"
          placeholder="Your max"
          value={maxText}
          onChange={(event) => setMaxText(event.target.value)}
          onKeyDown={submitOnEnter}
          className={cn(presetClass, "mt-8 w-full cursor-text border-line px-16 font-mono")}
        />
      )}

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        aria-busy={pending}
        className={buttonClass({ variant: "lime", size: 56, fullWidth: true, className: "mt-12 justify-between" })}
      >
        <span>{maxOpen ? "Set max" : "Place bid"}</span>
        <span className="font-mono">
          {maxOpen ? maxCents !== null && <Money cents={maxCents} /> : <Money cents={amountCents} />}
        </span>
      </button>
      {notice && (
        <p role="alert" className="mt-12 text-13 leading-20 text-ink2">
          {notice.message}
          {notice.link && (
            <>
              {" "}
              <Link href={notice.link.href} className="font-medium text-ink underline">
                {notice.link.label}
              </Link>
            </>
          )}
        </p>
      )}
      <p className="mt-12 flex items-center gap-8 text-12.5 text-ink2">
        <LockIcon size={15} />
        Held with PayPal. You’re only charged if you win.
      </p>

      <button
        type="button"
        onClick={() => openGlim({ lotNumber: lot.number })}
        className="mt-18 flex w-full cursor-pointer items-center gap-10 border-t border-line pt-18 text-14 font-semibold"
      >
        <Orb size={26} glow="soft" />
        Let the agent bid on this lot
        <span aria-hidden="true" className="ml-auto font-medium text-muted">
          →
        </span>
      </button>
    </section>
  );
}

/** A closed lot: the final figures and how it ended, in the pills of 10 and 11. Nothing left to do. */
function ClosedBidCard({ lot, timeZone }: Pick<BidCardProps, "lot" | "timeZone">) {
  const closedAt = formatClockTime(lot.closesAt, timeZone);
  return (
    <section aria-label="Place a bid" className="mt-22 rounded-22 border border-line p-20">
      <div className="flex items-center justify-between">
        <Eyebrow>{lot.currentBidCents === null ? "Starting bid" : "Final bid"}</Eyebrow>
        {lot.viewerStatus === "won" ? (
          <StatusPill status="winning">Won at {closedAt}</StatusPill>
        ) : (
          <StatusPill status="closed">Closed at {closedAt}</StatusPill>
        )}
      </div>
      <p className="mt-12 font-mono text-56 leading-none font-medium tracking-display">
        <Money cents={lot.currentBidCents ?? lot.startingBidCents} />
      </p>
      <div className="mt-12 flex gap-16 text-13 text-ink2">
        <span className="inline-flex items-center gap-6">{formatBidCount(lot.bidCount)}</span>
      </div>
    </section>
  );
}
