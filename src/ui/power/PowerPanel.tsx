"use client";

import Link from "next/link";
import { useState, type ChangeEvent } from "react";

import {
  highestHoldCents,
  holdAmountIssue,
  lowestHoldCents,
  type HoldAmountIssue,
  type HoldLimits,
  type HoldStanding,
} from "@/server/holds/rules";

import { cn } from "../cn";
import { Eyebrow } from "../Eyebrow";
import { formatUsd } from "../format";
import { ArrowRightIcon, LockIcon } from "../icons";
import { Money } from "../Money";

import { holdFlowCopy, type HoldFlowCopy, type HoldNotice } from "./hold-flow";
import { HowTheHoldWorks } from "./HowTheHoldWorks";
import { continueInThisTab } from "./hold-window";
import { HowTheRaiseWorks } from "./HowTheRaiseWorks";
import { AlertIcon, NewWindowIcon, NoticeMark, SpinnerIcon } from "./icons";
import { useHoldWindow } from "./useHoldWindow";

const SEGMENT = "flex h-48 items-center justify-center rounded-12 border text-15 font-medium tabular-nums";
const HOLD_BUTTON = "flex h-56 w-full items-center justify-between rounded-16 pr-20 pl-22 text-16 font-semibold";
const MAX_DIGITS = 7;

type Choice = { kind: "preset"; cents: number } | { kind: "other"; digits: string };

/** The setup page's words (09) and the raise page's (design/20 frame 12). */
function wordsFor(raising: boolean, currentHoldCents: number | null, highestCents: number) {
  if (!raising || currentHoldCents === null) {
    return {
      eyebrow: "Before you bid",
      title: "Set your bidding power",
      lede: "The most you and Glim can bid tonight.",
      promise: "It’s a hold with PayPal, not a charge.",
      amountLabel: "Amount to hold",
      amountNote: "You can raise it later with another hold",
      trust: "You’ll approve the hold in a PayPal window, then come back to bid.",
    };
  }
  return {
    eyebrow: "Need more room?",
    title: "Raise your bidding power",
    lede: `You have ${formatUsd(currentHoldCents)} held.`,
    promise: "A raise is a new hold, not a charge.",
    amountLabel: "New total to hold",
    amountNote: `Up to ${formatUsd(highestCents)}`,
    trust: `Until you approve, your ${formatUsd(currentHoldCents)} hold stays as it is.`,
  };
}

/** The amount a page starts on: the approved middle preset, or when raising the smallest step up. */
function defaultPreset(presets: readonly number[], raising: boolean): number | undefined {
  return presets[raising ? 0 : Math.floor(presets.length / 2)];
}

function firstChoice(linkedCents: number | null, presets: readonly number[], raising: boolean): Choice {
  if (linkedCents !== null) {
    return presets.includes(linkedCents)
      ? { kind: "preset", cents: linkedCents }
      : { kind: "other", digits: String(linkedCents / 100) };
  }
  const fallback = defaultPreset(presets, raising);
  return fallback === undefined ? { kind: "other", digits: "" } : { kind: "preset", cents: fallback };
}

function chosenAmount(choice: Choice): number | null {
  if (choice.kind === "preset") return choice.cents;
  return choice.digits === "" ? null : Number(choice.digits) * 100;
}

/** A page with nothing to choose. Undrawn: plain copy, with no image to replace it yet. */
function NothingToHold({ title, line, returnHref }: { title: string; line: string; returnHref: string }) {
  return (
    <main className="mx-auto flex w-880 flex-col items-center pt-96 text-center">
      <Eyebrow className="leading-16">Bidding power</Eyebrow>
      <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title">{title}</h1>
      <p className="mt-8 text-16 leading-24 text-ink2">{line}</p>
      <Link href={returnHref} className="mt-24 text-14 font-medium underline">
        Back to the lots
      </Link>
    </main>
  );
}

export interface PowerPanelProps {
  slug: string;
  limits: HoldLimits;
  currentHoldCents: number | null;
  committedCents: number;
  biddingEnded: boolean;
  exampleLot: string | null;
  /** "9:30 PM", when the event closes. */
  closesLabel: string;
  /** Where the guest goes once the hold is approved: a page of this event. */
  returnHref: string;
  /** The amount a link asked for, if any. */
  initialCents: number | null;
}

/** Screen 09's one column: choose an amount, understand the hold, approve it in a PayPal window. */
export function PowerPanel({
  slug,
  limits,
  currentHoldCents,
  committedCents,
  biddingEnded,
  exampleLot,
  closesLabel,
  returnHref,
  initialCents,
}: PowerPanelProps) {
  const { state, start, reset } = useHoldWindow({ slug, returnHref });

  // A hold that lands refreshes these props, which must not turn the page into something else under
  // the guest in the moment before they go back to bid. This component stays mounted whatever the
  // props say, because leaving for the lots is its effect to finish.
  const live: HoldStanding = { currentHoldCents, committedCents };
  const [startedWith, setStartedWith] = useState(live);
  const standing = state.phase === "approved" ? startedWith : live;

  const raising = standing.currentHoldCents !== null;
  const lowestCents = lowestHoldCents(limits, standing);
  const highestCents = highestHoldCents(limits);
  const presets = limits.presetsCents.filter((cents) => cents >= lowestCents && cents <= highestCents);

  const [choice, setChoice] = useState<Choice>(() => {
    const linkIsUsable = initialCents !== null && holdAmountIssue(initialCents, limits, standing) === null;
    return firstChoice(linkIsUsable ? initialCents : null, presets, raising);
  });
  // A preset can drop out when a hold lands in another tab; the page then starts over from the rest.
  const shown = choice.kind === "preset" && !presets.includes(choice.cents) ? firstChoice(null, presets, raising) : choice;
  const amountCents = chosenAmount(shown);
  const issue = amountCents === null ? null : holdAmountIssue(amountCents, limits, standing);
  const chosenCents = amountCents !== null && issue === null ? amountCents : null;

  const copy = holdFlowCopy(state, chosenCents);
  const words = wordsFor(raising, standing.currentHoldCents, highestCents);
  // While "Other…" is empty or out of range, the explainer stays on an amount that can be held.
  const explainedCents = chosenCents ?? defaultPreset(presets, raising) ?? lowestCents;

  function choose(next: Choice) {
    if (state.phase !== "idle") reset();
    setChoice(next);
  }

  function typeOther(event: ChangeEvent<HTMLInputElement>) {
    choose({ kind: "other", digits: event.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, MAX_DIGITS) });
  }

  function hold() {
    if (chosenCents === null) return;
    setStartedWith(live);
    start(chosenCents);
  }

  if (state.phase !== "approved") {
    if (biddingEnded) {
      return (
        <NothingToHold
          title="Bidding has closed"
          line="There’s nothing to hold now. You pay only for the lots you won."
          returnHref={returnHref}
        />
      );
    }
    if (lowestCents > highestCents) {
      return (
        <NothingToHold
          title="Your bidding power is at the top"
          line={`You have ${formatUsd(standing.currentHoldCents ?? 0)} held, the most you can hold tonight.`}
          returnHref={returnHref}
        />
      );
    }
  }

  const segmentTone = (selected: boolean) =>
    selected ? "border-ink bg-ink text-white" : cn("border-line", copy.locked && "opacity-40");

  return (
    <main className="mx-auto flex w-880 flex-col items-center pt-96 text-center tabular-nums">
      <Eyebrow className="leading-16">{words.eyebrow}</Eyebrow>
      <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title">{words.title}</h1>
      <p className="mt-8 text-16 leading-24 text-ink2">
        {words.lede} <b className="font-medium text-ink">{words.promise}</b>
      </p>

      <div className="w-480 text-left">
        <div className={cn(raising ? "mt-32" : "mt-40", "flex items-baseline justify-between")}>
          <Eyebrow className="leading-16">{words.amountLabel}</Eyebrow>
          <span className="text-12.5 leading-16 text-muted">{copy.amountNote ?? words.amountNote}</span>
        </div>
        <div
          role="radiogroup"
          aria-label={words.amountLabel}
          className="mt-8 grid gap-8 font-mono"
          style={{ gridTemplateColumns: `repeat(${presets.length + 1}, minmax(0, 1fr))` }}
        >
          {presets.map((cents) => {
            const selected = shown.kind === "preset" && shown.cents === cents;
            return (
              <button
                key={cents}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={formatUsd(cents)}
                disabled={copy.locked}
                onClick={() => choose({ kind: "preset", cents })}
                className={cn(SEGMENT, segmentTone(selected), !copy.locked && "cursor-pointer")}
              >
                <Money cents={cents} />
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={shown.kind === "other"}
            disabled={copy.locked}
            onClick={() => choose({ kind: "other", digits: shown.kind === "other" ? shown.digits : "" })}
            className={cn(SEGMENT, "font-sans", segmentTone(shown.kind === "other"), !copy.locked && "cursor-pointer")}
          >
            Other…
          </button>
        </div>

        {/* design/20 frames 7 and 8: digits only, so cents can't be typed. */}
        {shown.kind === "other" && (
          <>
            <input
              aria-label="Other amount, in whole dollars"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              disabled={copy.locked}
              value={shown.digits === "" ? "" : `$${Number(shown.digits).toLocaleString("en-US")}`}
              onChange={typeOther}
              placeholder="$"
              className="mt-8 h-48 w-full rounded-12 px-16 font-mono text-15 font-medium tabular-nums outline-none inset-ring-[1.5px] inset-ring-ink placeholder:text-muted"
            />
            {issue ? (
              <p role="alert" className="mt-8 flex items-center gap-6 text-12.5 leading-16 whitespace-nowrap text-ink2">
                <AlertIcon />
                <span>
                  <IssueLine issue={issue} />
                </span>
              </p>
            ) : (
              <p className="mt-8 text-12.5 leading-16 whitespace-nowrap text-muted">
                Whole dollars, <Amount cents={lowestCents} /> to <Amount cents={highestCents} />.
              </p>
            )}
          </>
        )}
      </div>

      {raising && standing.currentHoldCents !== null ? (
        <HowTheRaiseWorks newHoldCents={explainedCents} currentHoldCents={standing.currentHoldCents} />
      ) : (
        <HowTheHoldWorks holdCents={explainedCents} closesLabel={closesLabel} exampleLot={exampleLot} />
      )}

      <div className={cn(raising ? "mt-24" : "mt-40", "w-480 text-left")}>
        {copy.notice && <Notice notice={copy.notice} />}
        <HoldButton copy={copy} onHold={hold} />
        {copy.continueHref && (
          <p className="mt-16 flex items-center gap-6 text-13 leading-18 whitespace-nowrap text-ink2">
            Didn’t open?
            <a
              href={copy.continueHref}
              onClick={(event) => {
                // Marks this tab as PayPal's, so the return page goes back to the auction at once
                // rather than saying the window closes (design/17 frame 3).
                if (state.phase !== "waiting") return;
                event.preventDefault();
                continueInThisTab({ holdId: state.holdId, approvalUrl: state.approvalUrl }, window);
              }}
              className="flex items-center gap-6 font-semibold text-ink"
            >
              Continue in this tab
              <ArrowRightIcon size={14} />
            </a>
          </p>
        )}
        <p className={cn(copy.continueHref ? "mt-10" : "mt-16", "flex items-center gap-8 text-12.5 leading-18 text-ink2")}>
          {copy.trustIcon === "window" ? <BrowserWindowIcon size={15} /> : <LockIcon size={15} />}
          {copy.trust ?? words.trust}
        </p>
      </div>
    </main>
  );
}

/**
 * The button. While PayPal's window is open it reads as a status on the Surface, with a spinner in
 * the arrow's place (design/20 frame 9): still the column's one button, disabled and busy.
 */
function HoldButton({ copy, onHold }: { copy: HoldFlowCopy; onHold: () => void }) {
  const spaced = cn(HOLD_BUTTON, copy.notice && "mt-12");
  if (copy.status !== null) {
    return (
      <button type="button" disabled aria-busy={copy.status === "waiting"} className={cn(spaced, "bg-surface text-ink")}>
        {copy.button}
        {copy.status === "waiting" && <SpinnerIcon size={20} className="text-ink" />}
      </button>
    );
  }
  return (
    <button
      type="button"
      disabled={!copy.buttonEnabled}
      onClick={onHold}
      className={cn(spaced, copy.buttonEnabled ? "cursor-pointer bg-lime text-ink" : "bg-surface text-muted")}
    >
      {copy.button}
      {copy.buttonIcon === "arrow" ? <ArrowRightIcon size={18} /> : <NewWindowIcon size={18} />}
    </button>
  );
}

/** design/17 frame 5's line: a browser window, where the others have the lock. */
function BrowserWindowIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-none">
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <path d="M3.5 9.5h17" />
    </svg>
  );
}

/** What just happened, in design/20's quiet panel right above the button (frames 10 and 11). */
function Notice({ notice }: { notice: HoldNotice }) {
  return (
    <div role="status" className="flex items-center gap-14 rounded-16 bg-surface px-16 py-14">
      <span className="flex size-32 flex-none items-center justify-center rounded-full bg-white text-ink">
        {notice.mark === "confirming" ? <SpinnerIcon size={16} /> : <NoticeMark kind={notice.mark} />}
      </span>
      <div>
        <b className="block text-15 leading-20 font-semibold">{notice.title}</b>
        <span className="mt-2 block text-13 leading-18 text-muted">{notice.body}</span>
      </div>
    </div>
  );
}

/** An amount in a help line, as design/20 sets it: mono, medium, in ink. */
function Amount({ cents }: { cents: number }) {
  return (
    <b className="font-mono font-medium text-ink">
      <Money cents={cents} />
    </b>
  );
}

/** holdAmountMessage's sentences (src/server/holds/rules.ts), with the amounts set as design/20 sets them. */
function IssueLine({ issue }: { issue: HoldAmountIssue }) {
  switch (issue.reason) {
    case "not_whole_dollars":
      return "Enter a whole dollar amount.";
    case "below_minimum":
      return (
        <>
          The least you can hold is <Amount cents={issue.minCents} />.
        </>
      );
    case "above_maximum":
      return (
        <>
          The most you can hold is <Amount cents={issue.maxCents} />.
        </>
      );
    case "not_a_raise":
      return (
        <>
          You already hold <Amount cents={issue.currentHoldCents} />. Choose more than that.
        </>
      );
    case "below_commitments":
      return (
        <>
          Your bids already need <Amount cents={issue.committedCents} /> of bidding power. Choose at least that.
        </>
      );
  }
}
