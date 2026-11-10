import Link from "next/link";
import type { ReactNode } from "react";

import { buttonClass, Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { formatPaddleNumber, formatUsd } from "@/ui/format";
import { ArrowRightIcon, LockIcon } from "@/ui/icons";
import { Countdown } from "@/ui/LiveTime";
import { Money } from "@/ui/Money";
import { Orb } from "@/ui/Orb";

import type { CheckMark, FootAction, HeadingTone, RailCopy, RailFoot, RailMark, RailSection } from "./ledger-model";
import { Spinner } from "./Spinner";

const MONO_CAPS = "font-mono text-11.5 leading-16 tracking-caps uppercase";
const SECTION_RULE = "border-t border-[rgba(11,11,12,.08)] pt-20";

const HEADING_TONE: Record<HeadingTone, string> = {
  wait: "text-muted",
  ok: "font-medium text-ink",
  fail: "font-medium text-ink",
};

/** 13b's check in a circle at 12's 22px: white when passed, a hollow ring while it waits, ink when it failed. */
function CheckMarkIcon({ mark }: { mark: CheckMark }) {
  if (mark === "pending") {
    return <span className="block size-22 flex-none rounded-full shadow-[inset_0_0_0_1.5px_#BDBCB7]" />;
  }
  return (
    <span className={cn("flex size-22 flex-none items-center justify-center rounded-full", mark === "failed" ? "bg-ink text-white" : "bg-white text-ink")}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin={mark === "failed" ? undefined : "round"} aria-hidden="true">
        <path d={mark === "failed" ? "M7 7l10 10M17 7L7 17" : "M5 12.5l4.5 4.5L19 7.5"} />
      </svg>
    </span>
  );
}

function HoldMark({ mark }: { mark: RailMark }) {
  if (mark === "lock") return <LockIcon size={18} />;
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={mark === "check" ? 2.4 : 2.6} strokeLinecap="round" strokeLinejoin={mark === "check" ? "round" : undefined} aria-hidden="true">
      {mark === "check" ? (
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      ) : (
        <>
          <path d="M12 5v9.5" />
          <path d="M12 19v.01" />
        </>
      )}
    </svg>
  );
}

/** "Charging 7 of 19": the title's figures in Geist Mono. */
function Title({ copy }: { copy: RailCopy }) {
  let body: ReactNode = copy.title;
  if (copy.countdownTo !== null) {
    body = (
      <>
        {copy.title} <Countdown closesAt={copy.countdownTo} className="font-mono font-medium tracking-[-.03em]" />
      </>
    );
  } else if (copy.monoFigures) {
    body = copy.title.split(/(\d+)/).map((part, index) =>
      /^\d+$/.test(part) ? (
        <span key={index} className="font-mono font-medium tracking-[-.03em]">
          {part}
        </span>
      ) : (
        part
      ),
    );
  }
  // Below 1440 the title may wrap, and never leaves one word on its own line ("1 failed, / 1 waiting").
  return (
    <h1 className="mt-8 text-[24px] leading-32 font-semibold tracking-title whitespace-nowrap max-desk:whitespace-normal max-desk:text-pretty max-xl:col-start-1">
      {body}
    </h1>
  );
}

const FOOT_BUTTON = "flex h-48 items-center justify-center rounded-16 text-15 font-semibold whitespace-nowrap";

interface LedgerRailProps {
  copy: RailCopy;
  section: RailSection;
  foot: RailFoot;
  transaction: { paddleNumber: number; captureId: string } | null;
  receiptHref: string | null;
  error: string | null;
  onAction: (action: FootAction) => void;
  /** The flexible gap above the foot, which the page measures to keep the ledger as tall as the rail. */
  spacerRef?: (element: HTMLDivElement | null) => void;
}

/** 12's decision rail: what is held, what will be charged and released, the checks, the one action. */
export function LedgerRail({ copy, section, foot, transaction, receiptHref, error, onAction, spacerRef }: LedgerRailProps) {
  return (
    <aside
      aria-label={copy.countdownTo === null ? copy.title : copy.eyebrow}
      className="flex min-w-0 flex-col rounded-24 bg-surface p-28 max-xl:order-first max-xl:grid max-xl:grid-cols-2 max-xl:content-start max-xl:gap-x-48 max-md:flex max-md:p-20"
    >
      <span className={cn("block text-muted max-xl:col-start-1", MONO_CAPS)}>{copy.eyebrow}</span>
      <Title copy={copy} />

      <div className="mt-20 flex items-center gap-14 max-xl:col-start-1">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white">
          <HoldMark mark={copy.mark} />
        </span>
        <div className="min-w-0">
          <b className="block text-16 leading-22 font-semibold whitespace-nowrap max-desk:whitespace-normal max-desk:text-pretty">{copy.holdLine}</b>
          <span className="mt-2 block text-13 leading-18 whitespace-nowrap text-muted max-desk:whitespace-normal max-desk:text-pretty">{copy.holdSub}</span>
        </div>
      </div>

      <div className="mt-24 grid grid-cols-[auto_auto] items-baseline justify-between whitespace-nowrap max-xl:col-start-1 max-md:gap-x-12">
        <b className="font-mono text-[48px] leading-52 font-medium tracking-display text-ink max-md:text-40 max-md:leading-44">
          <Money cents={copy.left.cents} />
        </b>
        <b className="justify-self-end font-mono text-[24px] leading-28 font-medium tracking-[-.03em] text-ink">
          <Money cents={copy.right.cents} />
        </b>
        <span className="text-14 leading-20 text-muted">{copy.left.label}</span>
        <span className="justify-self-end text-14 leading-20 text-muted">{copy.right.label}</span>
      </div>
      <div
        role="img"
        aria-label={`${formatUsd(copy.left.cents)} ${copy.left.label} and ${formatUsd(copy.right.cents)} ${copy.right.label}`}
        className="mt-12 flex h-10 gap-6 max-xl:col-start-1"
      >
        <i className="block h-full rounded-[5px] bg-ink" style={{ flex: `${copy.left.cents} 1 0` }} />
        <i
          className={cn(
            "block h-full rounded-[5px]",
            copy.bar === "released" ? "bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" : "bg-[rgba(11,11,12,.10)]",
          )}
          style={{ flex: `${copy.right.cents} 1 0` }}
        />
      </div>
      <p className="mt-12 text-13 leading-20 whitespace-nowrap text-ink2 max-desk:whitespace-normal max-desk:text-pretty max-xl:col-start-1">
        <span className="block">{copy.caption[0]}</span>
        <span className="block">{copy.caption[1]}</span>
      </p>
      {copy.note && <p className="mt-4 text-12.5 leading-18 whitespace-nowrap text-muted max-desk:whitespace-normal max-desk:text-pretty max-xl:col-start-1">{copy.note}</p>}

      {/* On a tablet the checks stand beside the figures, as a second column. */}
      <div className={cn("mt-24", SECTION_RULE, "max-xl:col-start-2 max-xl:row-span-7 max-xl:row-start-1 max-xl:mt-0 max-xl:border-t-0 max-xl:pt-0 max-md:mt-24 max-md:border-t max-md:pt-20")}>
        <div className="flex items-center justify-between">
          <span className={cn("text-muted", MONO_CAPS)}>{section.label}</span>
          <span className={cn(MONO_CAPS, HEADING_TONE[section.heading.tone])}>{section.heading.text}</span>
        </div>
        <ul className="mt-12">
          {section.rows.map((check) => (
            <li key={check.key} className={cn("mt-8 flex gap-10 first:mt-0", check.details.length > 0 ? "items-start" : "h-22 items-center max-desk:h-auto max-desk:items-start")}>
              <CheckMarkIcon mark={check.mark} />
              <span className={cn("min-w-0 text-14 whitespace-nowrap max-desk:leading-22 max-desk:whitespace-normal max-desk:text-pretty", check.mark === "pending" ? "text-ink2" : "text-ink")}>
                <span className={cn(check.details.length > 0 && "block leading-22")}>{check.label}</span>
                {check.details.map((detail) => (
                  <small key={detail} className="block text-12.5 leading-18 text-muted">
                    {detail}
                  </small>
                ))}
              </span>
            </li>
          ))}
        </ul>
        {section.glim && (
          <p className="mt-12 flex items-center gap-10 text-13.5 leading-22 whitespace-nowrap text-ink2 max-desk:items-start max-desk:whitespace-normal max-desk:text-pretty">
            <Orb size={22} />
            {section.glim}
          </p>
        )}
      </div>

      <div ref={spacerRef} className="flex-[1_0_16px] max-xl:col-span-2 max-xl:h-24 max-md:h-auto" />
      {foot.kind !== "none" || transaction ? (
        <div className={cn(SECTION_RULE, "max-xl:col-span-2")}>
          {transaction && (
            <p className="mb-12 flex h-20 items-center justify-between text-13 whitespace-nowrap text-muted max-md:h-auto max-md:flex-wrap max-md:gap-x-12 max-md:whitespace-normal">
              <span>Paddle {formatPaddleNumber(transaction.paddleNumber)} · PayPal transaction ID</span>
              <span className="font-mono text-12.5 text-ink">{transaction.captureId}</span>
            </p>
          )}
          {error && (
            <p role="alert" className="mb-12 text-12.5 leading-18 text-ink2">
              {error}
            </p>
          )}
          <Foot foot={foot} receiptHref={receiptHref} onAction={onAction} />
        </div>
      ) : null}
    </aside>
  );
}

function Foot({ foot, receiptHref, onAction }: { foot: RailFoot; receiptHref: string | null; onAction: (action: FootAction) => void }) {
  switch (foot.kind) {
    case "none":
      return null;
    case "off":
      return (
        <button type="button" disabled className={cn(FOOT_BUTTON, "w-full bg-white text-muted")}>
          {foot.label}
        </button>
      );
    case "pair":
      return (
        <div className="grid grid-cols-2 gap-x-8 max-sm:grid-cols-1 max-sm:gap-y-8">
          <button
            type="button"
            onClick={() => onAction(foot.now.action)}
            className={cn(FOOT_BUTTON, "cursor-pointer shadow-[inset_0_0_0_1px_var(--color-ink)]")}
          >
            {foot.now.label}
          </button>
          <button type="button" disabled className={cn(FOOT_BUTTON, "bg-white text-muted")}>
            {foot.next}
          </button>
        </div>
      );
    case "working":
      return (
        <p role="status" className="flex h-48 items-center justify-between rounded-16 bg-white pr-14 pl-20 text-15 font-semibold whitespace-nowrap">
          {foot.label}
          <Spinner size={20} />
        </p>
      );
    case "cta":
      if (foot.action === "receipt" && receiptHref) {
        return (
          <Link href={receiptHref} className={buttonClass({ variant: "lime", size: 48, fullWidth: true, className: "min-w-0 justify-between" })}>
            {foot.label}
            <ArrowRightIcon size={18} />
          </Link>
        );
      }
      return (
        <Button
          variant="lime"
          size={48}
          fullWidth
          disabled={!foot.enabled}
          onClick={() => onAction(foot.action)}
          className="min-w-0 justify-between disabled:cursor-default"
        >
          {foot.label}
          <ArrowRightIcon size={18} />
        </Button>
      );
  }
}
