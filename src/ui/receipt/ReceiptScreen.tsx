import Link from "next/link";
import type { ReactNode } from "react";

import { paypalIdOrNull } from "@/server/paypal/simulated-ids";
import type { ReceiptLot, ReceiptPhase, ReceiptView } from "@/server/queries/receipt-view";

import { CATEGORY_LABELS } from "../categories";
import { cn } from "../cn";
import { CornerOrb } from "../CornerOrb";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import { EventNav } from "../EventNav";
import { formatClockTime, formatLotNumber, formatPaddleNumber, formatUsd, keepTogether } from "../format";
import { LockIcon } from "../icons";
import { LiveRefresh } from "../live/LiveStream";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { OutcomePill } from "../OutcomePill";
import { PaddleMark } from "../PaddleMark";
import { DownloadIcon, HeartLineIcon, MailIcon, OpenLockIcon } from "../paddle/icons";
import { lotClockTime } from "../paddle/time";
import type { GuestLinks } from "../routes";
import { StatusPill } from "../StatusPill";

import { bidByLine, captionLines, charityLines, glimSay, receiptBubble, receiptDateParts, receiptTitle } from "./copy";
import { receiptPdfHref } from "./receipt-href";

/** "Sandbox demo · not a tax document": on the receipt's first line, in every state (design/25). */
export const SANDBOX_STAMP = "Sandbox demo · not a tax document";

/**
 * Screen 11 after bidding closes (mockups/11, design/25): the thank-you and what was won beside the
 * receipt. Paid reads the snapshot settlement wrote; the other states read the lots. The page asks the
 * server again when the guest's charge, hold or the event moves, so "pending" becomes "paid" by itself.
 */
export function ReceiptScreen({ view, links }: { view: ReceiptView; links: GuestLinks }) {
  const { phase } = view;
  const wonNothing = view.won.length === 0;
  // A guest who never held bidding power has nothing to pick up and nothing released to talk about.
  const bubble = view.hold ? receiptBubble(phase, view.event.pickupNote) : null;
  const tz = view.event.timeZone;

  return (
    <>
      <LiveRefresh types={["settlement", "hold", "event_status"]} />
      <EventNav
        event={{ ...view.event }}
        viewer={{
          paddleNumber: view.viewer.paddleNumber,
          firstName: view.viewer.firstName,
          holdCents: view.hold?.cents ?? null,
          availableCents: 0,
          heldCents: view.hold?.cents ?? null,
          wonCents: view.payCents,
          winningCount: 0,
          outbidCount: 0,
        }}
        links={links}
        active="paddle"
        power={<OutcomePill settled={phase === "paid" || phase === "released"} payCents={view.payCents} releaseCents={view.releaseCents} />}
      />

      <div className="mx-auto max-w-1344 px-48 pt-32 pb-120 tabular-nums max-desk:px-32 max-desk:pb-0 max-md:px-16 max-md:pt-24">
        <div
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_480px] gap-x-48 max-desk:gap-x-40 max-xl:items-start max-lg:grid-cols-1",
            wonNothing ? "items-start" : "items-stretch",
          )}
        >
          <main className="max-lg:contents">
            <span className="block font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Bidding closed</span>
            <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title whitespace-nowrap max-md:text-28 max-md:leading-34 max-md:text-balance max-md:whitespace-normal">
              Thank you, {view.viewer.firstName}.
            </h1>
            <p className="mt-8 flex items-center gap-8 text-16 leading-24 whitespace-nowrap text-ink2 max-md:items-start max-md:text-pretty max-md:whitespace-normal">
              <HeartLineIcon size={15} className="flex-none text-muted max-md:mt-5" />
              {wonNothing
                ? `Your bids helped raise the total for ${view.event.charityName}.`
                : `Your winning bids support ${view.event.charityName}.`}
            </p>

            <div className="mt-32 grid grid-cols-2 gap-x-24 gap-y-32 max-xl:grid-cols-1 max-lg:order-2 max-lg:grid-cols-2 max-md:mt-24 max-md:grid-cols-1 max-md:gap-y-24">
              {(wonNothing ? view.notWon : view.won).map((lot) => (
                <LotCard key={lot.lotId} lot={lot} won={!wonNothing} phase={phase} timeZone={tz} />
              ))}
            </div>

            <ReceiptRows view={view} timeZone={tz} />
          </main>

          <ReceiptPanel view={view} links={links} note={bubble} />
        </div>

        <p className="mt-20 flex items-center gap-8 text-12.5 leading-18 text-ink2 max-md:items-start max-md:text-pretty">
          <LockIcon size={15} className="flex-none max-md:mt-1" />
          {phase === "paid" ? "As promised, you paid only for the lots you won." : "As promised, you pay only for the lots you win."}
        </p>
      </div>

      {/*
        Below 1440 Glim closes the page, under the receipt, rather than resting on its buttons. Below 1024,
        where that end is past every lot, the receipt card says the bubble's news itself (ReceiptNote).
      */}
      <CornerOrb bubble={bubble ? { ...bubble, phone: "none" } : undefined} placement="page-end" />
    </>
  );
}

function Amount({ parts }: { parts: Array<string | { cents: number }> }) {
  return parts.map((part, index) =>
    typeof part === "string" ? (
      part
    ) : (
      <b key={index} className="font-mono font-medium text-ink">
        <Money cents={part.cents} />
      </b>
    ),
  );
}

function LotCard({ lot, won, phase, timeZone }: { lot: ReceiptLot; won: boolean; phase: ReceiptPhase; timeZone: string }) {
  const drawing = lot.coverDrawing && isDrawingKey(lot.coverDrawing) ? lot.coverDrawing : null;
  const at = lot.closedAt === null ? null : lotClockTime(lot.closedAt, timeZone);
  const by = bidByLine(lot, won);
  return (
    <article>
      <div className="relative flex h-176 items-center justify-center rounded-20 bg-stone-tile max-md:h-144">
        {won ? (
          <StatusPill status="winning" edge className="absolute top-12 left-12">
            {at ? `Won at ${at}` : "Won"}
          </StatusPill>
        ) : (
          // 20's closed tile: 10's grey pill, in white on the stone.
          <span className="absolute top-12 left-12 inline-flex h-30 items-center gap-6 rounded-full bg-white pr-12 pl-8 text-12.5 font-semibold whitespace-nowrap text-ink2">
            <PaddleMark tone="closed" size={16} />
            Not won
          </span>
        )}
        {drawing && <LotIllustration drawing={drawing} variant="tile" className={cn("relative top-10", !won && "opacity-50")} />}
      </div>
      <div className="pt-16">
        <span className="block font-mono text-11 leading-14 tracking-caps text-muted uppercase">
          Lot {formatLotNumber(lot.number)} · {CATEGORY_LABELS[lot.category]}
        </span>
        <h3
          className={cn(
            "mt-6 text-[17px] leading-24 font-semibold tracking-snug whitespace-nowrap max-md:text-balance max-md:whitespace-normal",
            !won && "text-muted",
          )}
        >
          {lot.title}
        </h3>
        <p className="mt-8 flex items-baseline gap-8">
          <b className="font-mono text-[24px] leading-32 font-medium tracking-[-.03em]">
            <Money cents={lot.paidCents} />
          </b>
          <span className="text-13.5 text-muted">{won && phase === "pending" ? "to pay" : "paid"}</span>
        </p>
        <p className="mt-8 flex h-22 items-center gap-8 text-13.5 whitespace-nowrap text-ink2 max-md:h-auto max-md:min-h-22 max-md:leading-20 max-md:whitespace-normal">
          {by?.glim && <Orb size={22} className="max-md:flex-none max-md:self-start" />}
          {by && (
            <span>
              <Amount parts={by.parts} />
            </span>
          )}
        </p>
        <p className="mt-16 flex justify-between border-t border-line pt-12 text-12.5 leading-18 whitespace-nowrap text-muted max-md:flex-wrap max-md:gap-x-12">
          {won ? (
            <>
              {lot.estimatedValueCents === null ? (
                <span>Estimated value not set</span>
              ) : (
                <span>
                  Estimated value
                  <b className="ml-4 font-mono font-medium text-muted">
                    <Money cents={lot.estimatedValueCents} />
                  </b>
                </span>
              )}
              <span>
                Tax-deductible
                <b className="ml-4 font-mono font-medium text-ink">
                  <Money cents={lot.deductibleCents} />
                </b>
              </span>
            </>
          ) : (
            <>
              <span>
                {lot.soldCents !== null && (
                  <>
                    Sold for{" "}
                    <b className="font-mono font-medium text-ink">
                      <Money cents={lot.soldCents} />
                    </b>
                  </>
                )}
                {at && ` at ${at}`}
              </span>
              <span className="font-medium text-ink">Never charged</span>
            </>
          )}
        </p>
      </div>
    </article>
  );
}

function ReceiptRows({ view, timeZone }: { view: ReceiptView; timeZone: string }) {
  const wonNothing = view.won.length === 0;
  const say = glimSay(view.glim, !wonNothing);
  const others = wonNothing ? [] : view.notWon;
  if (!say && others.length === 0) return null;
  return (
    <div className="mt-24 max-lg:order-3">
      {say && view.glim && (
        <div className="flex items-center gap-24 border-t border-line py-16 last:border-b max-xl:flex-col max-xl:items-start max-xl:gap-12">
          <div className="flex w-190 flex-none items-center gap-12 max-xl:w-auto">
            <Orb size={38} />
            <div>
              <b className="block text-15 leading-20 font-semibold">Glim</b>
              <span className="mt-1 flex items-center gap-6 text-12 leading-16 whitespace-nowrap text-muted">
                <i className="block size-7 rounded-full bg-muted" />
                Off duty since {formatClockTime(view.glim.offDutyAt, timeZone)}
              </span>
            </div>
          </div>
          <p className="text-15 leading-22 max-xl:text-pretty">
            <span className="block whitespace-nowrap max-xl:whitespace-normal">{say[0]}</span>
            {say[1] && <span className="block whitespace-nowrap max-xl:whitespace-normal">{say[1]}</span>}
          </p>
        </div>
      )}
      {others.map((lot) => (
        <div
          key={lot.lotId}
          className="flex items-center gap-24 border-t border-line py-16 whitespace-nowrap last:border-b max-xl:gap-16 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-x-16 max-md:gap-y-10 max-md:whitespace-normal"
        >
          <div className="flex w-190 flex-none items-center gap-12 max-xl:w-auto max-md:col-[1/2] max-md:row-[1/2]">
            <StatusPill status="closed">Not won</StatusPill>
          </div>
          <div className="max-md:col-[1/2] max-md:row-[2/3] max-md:min-w-0">
            <span className="block font-mono text-11 leading-14 tracking-caps text-muted uppercase">
              Lot {formatLotNumber(lot.number)} · {CATEGORY_LABELS[lot.category]}
            </span>
            <span className="mt-4 block text-14 leading-20 font-medium text-ink2">{lot.title}</span>
          </div>
          <p className="ml-auto text-right max-md:col-[2/3] max-md:row-[1/3] max-md:self-center max-md:whitespace-nowrap">
            <b className="block text-14 leading-20 font-semibold">Never charged</b>
            {lot.closedAt !== null && (
              <span className="mt-2 block text-12.5 leading-18 text-muted">Closed at {lotClockTime(lot.closedAt, timeZone)}</span>
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex h-20 items-center justify-between text-13 whitespace-nowrap text-muted [&+&]:mt-4 max-md:h-auto max-md:min-h-20 max-md:flex-wrap max-md:gap-x-12 max-md:[&>:last-child]:ml-auto">
      <span>{label}</span>
      {children}
    </p>
  );
}

const mono = "font-mono text-12.5 text-ink";

function ReceiptPanel({ view, links, note }: { view: ReceiptView; links: GuestLinks; note: { title: string; body: string } | null }) {
  const { phase } = view;
  const tz = view.event.timeZone;
  const paid = phase === "paid";
  const wonNothing = phase === "released" || phase === "release_pending";
  // The gala's date and close, the same in every state; the payment line says when the charge went through.
  const dated = view.event.closesAt;
  const [capFirst, capSecond] = captionLines(view);
  const [charityFirst, charitySecond] = charityLines(view.event);
  const holdAt = view.hold?.authorizedAt ? ` at ${formatClockTime(view.hold.authorizedAt, tz)}` : "";
  const settledFigures = phase === "paid" || phase === "released";
  const noPay = view.payCents === 0;
  const noRelease = view.releaseCents === 0;

  return (
    <aside className="flex flex-col rounded-24 bg-surface px-32 py-28 max-lg:order-1 max-lg:mt-28 max-md:mt-24 max-md:px-20 max-md:py-24 max-sm:px-16">
      <div className="font-mono text-11.5 tracking-caps text-muted uppercase">
        {/* On a phone the stamp comes first, on a line of its own: still the receipt's first line. */}
        <p className="flex h-26 items-center justify-between leading-26 max-md:h-auto max-md:flex-col-reverse max-md:items-start max-md:gap-y-12">
          <span className="font-medium text-ink">{receiptTitle(phase, view.receipt?.number ?? null)}</span>
          <span className="inline-flex h-26 items-center rounded-full bg-ink px-11 text-11 font-medium tracking-status whitespace-nowrap text-white max-sm:px-9 max-sm:text-10.5">
            {SANDBOX_STAMP}
          </span>
        </p>
        <p className="mt-4 flex justify-between leading-16 max-md:flex-wrap max-md:gap-x-12 max-md:gap-y-2">
          <ReceiptDate at={dated} timeZone={tz} />
          <span>
            Paddle {formatPaddleNumber(view.viewer.paddleNumber)} · {view.viewer.firstName}
          </span>
        </p>
      </div>

      {view.hold && (
        <div className="mt-20 flex items-center gap-14">
          <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white">
            {phase === "released" ? <OpenLockIcon size={18} /> : <LockIcon size={18} />}
          </span>
          <div>
            <b className="block text-16 leading-22 font-semibold max-md:text-pretty">
              {formatUsd(view.hold.cents)} held with PayPal{holdAt}
            </b>
            <span className="mt-2 block text-13 leading-18 text-muted">
              {phase === "pending" || phase === "release_pending"
                ? "Nothing has been charged yet."
                : view.glim
                  ? "Your bids and Glim’s stayed within it."
                  : "Your bids stayed within it."}
            </span>
          </div>
        </div>
      )}

      {/* On a phone what was released goes under what was paid, over its end of the bar. */}
      <div className="mt-24 flex items-baseline justify-between whitespace-nowrap max-md:flex-col max-md:items-stretch max-md:gap-y-4">
        <span className="flex items-baseline gap-8 text-14 text-muted max-md:flex-wrap">
          <b className="font-mono text-[48px] leading-52 font-medium tracking-display text-ink max-md:text-40 max-md:leading-44">
            <Money cents={view.payCents} />
          </b>
          {settledFigures ? "paid with PayPal" : "to pay with PayPal"}
        </span>
        <span className="flex items-baseline gap-8 text-14 text-muted max-md:self-end">
          <b className="font-mono text-[24px] leading-28 font-medium tracking-[-.03em] text-ink">
            <Money cents={view.releaseCents} />
          </b>
          {settledFigures ? "released" : "to release"}
        </span>
      </div>
      <div
        className="mt-12 flex h-10 gap-6"
        role="img"
        aria-label={
          noPay
            ? `${formatUsd(0)} ${settledFigures ? "paid" : "to pay"} and all ${formatUsd(view.releaseCents)} ${settledFigures ? "released" : "to release"}`
            : `${formatUsd(view.payCents)} ${settledFigures ? "paid" : "to pay"} and ${formatUsd(view.releaseCents)} ${settledFigures ? "released" : "to release"}, of the ${formatUsd(view.payCents + view.releaseCents)} held`
        }
      >
        {!noPay && <i className="block h-full rounded-[5px] bg-ink" style={{ flex: `${view.payCents} 1 0` }} />}
        {!noRelease && (
          <i className="block h-full rounded-[5px] bg-lime inset-ring inset-ring-lime-edge" style={{ flex: `${view.releaseCents} 1 0` }} />
        )}
      </div>
      <p className="mt-12 text-13 leading-20 whitespace-nowrap text-ink2 max-md:text-pretty max-md:whitespace-normal">
        <span className="block">{capFirst}</span>
        <span className="block">{capSecond}</span>
      </p>
      <p className="mt-4 text-12.5 leading-18 whitespace-nowrap text-muted max-md:text-pretty max-md:whitespace-normal">
        {phase === "pending" || phase === "release_pending"
          ? "Nothing for you to do. This page updates on its own."
          : "Some banks take a few days to remove a released hold."}
      </p>

      {!wonNothing && (
        <div className="mt-24 border-t border-ink/8 pt-24">
          <p className="flex items-baseline gap-8 text-14 whitespace-nowrap text-muted">
            <b className="font-mono text-[24px] leading-28 font-medium tracking-[-.03em] text-ink">
              <Money cents={view.deductibleCents} />
            </b>
            tax-deductible
          </p>
          <p className="mt-8 text-13 leading-20 whitespace-nowrap text-ink2 max-md:text-pretty max-md:whitespace-normal">
            Only what you pay above an item’s estimated value is tax-deductible.
          </p>
          {paid && (
            <p className="mt-8 text-12 leading-18 text-muted max-md:text-pretty">
              <span className="block whitespace-nowrap max-md:whitespace-normal">{charityFirst}</span>
              {charitySecond && <span className="block whitespace-nowrap max-md:whitespace-normal">{charitySecond}</span>}
            </p>
          )}
        </div>
      )}

      <div className="flex-[1_0_20px]" />

      <div className="border-t border-ink/8 pt-20">
        {wonNothing ? (
          <>
            {view.hold && (
              <Detail label="PayPal hold ID">
                <span className={mono}>{paypalIdOrNull(view.hold.authorizationId) ?? "Simulated"}</span>
              </Detail>
            )}
            <Detail label="On your statement">
              <span className={mono}>No charge</span>
            </Detail>
          </>
        ) : (
          <>
            <Detail label="PayPal transaction ID">
              {paid ? (
                <span className={mono}>{paypalIdOrNull(view.receipt?.captureId) ?? "Simulated"}</span>
              ) : (
                <span className="text-12.5 text-muted">After you’re charged</span>
              )}
            </Detail>
            {view.event.statementLabel && (
              <Detail label="On your statement">
                <span className={mono}>{view.event.statementLabel}</span>
              </Detail>
            )}
            <div className="mt-20 flex items-center gap-8 max-md:flex-col max-md:items-stretch">
              {paid ? (
                <>
                  <Link
                    href={receiptPdfHref(links)}
                    className="flex h-48 flex-1 items-center justify-between gap-10 rounded-16 bg-lime pr-16 pl-20 text-15 font-semibold whitespace-nowrap text-ink max-md:flex-none"
                  >
                    Download receipt
                    <span className="flex items-center gap-10">
                      <small className="font-mono text-11 font-medium tracking-label">PDF</small>
                      <DownloadIcon size={18} />
                    </span>
                  </Link>
                  <a
                    href={emailHref(view)}
                    className="flex h-48 items-center gap-8 pl-16 text-14 font-medium whitespace-nowrap text-ink max-md:justify-center max-md:rounded-16 max-md:bg-white max-md:pl-0"
                  >
                    <MailIcon size={17} />
                    Email me a copy
                  </a>
                </>
              ) : (
                <span
                  role="button"
                  aria-disabled="true"
                  className="flex h-48 flex-1 items-center justify-between gap-10 rounded-16 bg-white pr-16 pl-20 text-15 font-semibold whitespace-nowrap text-muted max-md:flex-none"
                >
                  Download receipt
                  <span className="flex items-center gap-10">
                    <small className="font-mono text-11 font-medium tracking-label">PDF</small>
                    <DownloadIcon size={18} />
                  </span>
                </span>
              )}
            </div>
          </>
        )}
      </div>
      {note && <ReceiptNote note={note} />}
    </aside>
  );
}

/** "Tue, November 10, 2026 · 9:30 PM", with the time kept whole when the line wraps. */
function ReceiptDate({ at, timeZone }: { at: number; timeZone: string }) {
  const [date, time] = receiptDateParts(at, timeZone, "short");
  return <span>{`${date} · ${keepTogether(time)}`}</span>;
}

/**
 * Below 1024: Glim's corner note (the pickup note, or what comes next) as the receipt's last line, in
 * the same words, where a guest at the front desk is looking. The corner closes the page with the orb
 * alone there. From 1024 the bubble says it, beside the receipt.
 */
function ReceiptNote({ note }: { note: { title: string; body: string } }) {
  return (
    <div role="note" className="mt-20 hidden items-start gap-12 border-t border-ink/8 pt-20 max-lg:flex">
      <Orb size={26} />
      <p className="min-w-0 text-13 leading-18 text-muted">
        <b className="block text-13.5 leading-20 font-semibold text-ink">{note.title}</b>
        <span className="mt-2 block">{note.body}</span>
      </p>
    </div>
  );
}

/**
 * "Email me a copy" with no mail service: a draft in the guest's own mail app, addressed by them, with
 * the receipt's figures. Nothing is sent from Fairhold.
 */
function emailHref(view: ReceiptView): string {
  const number = view.receipt?.number ?? "";
  const transactionId = paypalIdOrNull(view.receipt?.captureId);
  const lines = [
    `${view.event.name}, paddle ${formatPaddleNumber(view.viewer.paddleNumber)}`,
    `${SANDBOX_STAMP}.`,
    `Paid with PayPal: ${formatUsd(view.payCents)}. Released: ${formatUsd(view.releaseCents)}.`,
    ...view.won.map((lot) => `Lot ${formatLotNumber(lot.number)}, ${lot.title}: ${formatUsd(lot.paidCents)}`),
    transactionId ? `PayPal transaction ID: ${transactionId}` : null,
  ].filter((line): line is string => line !== null);
  const query = new URLSearchParams({ subject: `Sandbox demo receipt ${number}, not a tax document`, body: lines.join("\n") });
  return `mailto:?${query.toString().replace(/\+/g, "%20")}`;
}
