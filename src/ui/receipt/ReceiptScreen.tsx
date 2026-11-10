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
import { formatClockTime, formatLotNumber, formatPaddleNumber, formatUsd } from "../format";
import { LockIcon } from "../icons";
import { LiveRefresh } from "../live/LiveStream";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";
import { DownloadIcon, HeartLineIcon, MailIcon, OpenLockIcon } from "../paddle/icons";
import { lotClockTime } from "../paddle/time";
import type { GuestLinks } from "../routes";
import { StatusPill } from "../StatusPill";

import { bidByLine, captionLines, charityLines, glimSay, receiptBubble, receiptDate, receiptTitle } from "./copy";
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
          winningCount: 0,
          outbidCount: 0,
        }}
        links={links}
        active="paddle"
        power={<OutcomePill phase={phase} payCents={view.payCents} releaseCents={view.releaseCents} />}
      />

      <div className="mx-auto max-w-1344 px-48 pt-32 pb-120 tabular-nums">
        <div className={cn("grid grid-cols-[minmax(0,1fr)_480px] gap-x-48", wonNothing ? "items-start" : "items-stretch")}>
          <main>
            <span className="block font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Bidding closed</span>
            <h1 className="mt-8 text-34 leading-40 font-semibold tracking-title whitespace-nowrap">Thank you, {view.viewer.firstName}.</h1>
            <p className="mt-8 flex items-center gap-8 text-16 leading-24 whitespace-nowrap text-ink2">
              <HeartLineIcon size={15} className="flex-none text-muted" />
              {wonNothing
                ? `Your bids helped raise the total for ${view.event.charityName}.`
                : `Your winning bids support ${view.event.charityName}.`}
            </p>

            <div className="mt-32 grid grid-cols-2 gap-x-24 gap-y-32">
              {(wonNothing ? view.notWon : view.won).map((lot) => (
                <LotCard key={lot.lotId} lot={lot} won={!wonNothing} phase={phase} timeZone={tz} />
              ))}
            </div>

            <ReceiptRows view={view} timeZone={tz} />
          </main>

          <ReceiptPanel view={view} links={links} />
        </div>

        <p className="mt-20 flex items-center gap-8 text-12.5 leading-18 text-ink2">
          <LockIcon size={15} />
          {phase === "paid" ? "As promised, you paid only for the lots you won." : "As promised, you pay only for the lots you win."}
        </p>
      </div>

      <CornerOrb bubble={bubble ?? undefined} />
    </>
  );
}

/** 11's nav pill: what was paid and released, or what will be. */
function OutcomePill({ phase, payCents, releaseCents }: { phase: ReceiptPhase; payCents: number; releaseCents: number }) {
  const settled = phase === "paid" || phase === "released";
  return (
    <div className="flex h-40 items-center gap-10 rounded-full bg-ink px-14 font-mono text-13 text-white">
      <span className="flex items-center gap-10">
        <small className="text-10.5 tracking-label text-on-ink-muted uppercase">{settled ? "Paid" : "To pay"}</small>
        <b className="font-medium">
          <Money cents={payCents} />
        </b>
      </span>
      <span className="text-on-ink-muted">·</span>
      <span className="flex items-center gap-10">
        <small className="text-10.5 tracking-label text-on-ink-muted uppercase">{settled ? "Released" : "To release"}</small>
        <b className="font-medium text-lime">
          <Money cents={releaseCents} />
        </b>
      </span>
    </div>
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
      <div className="relative flex h-176 items-center justify-center rounded-20 bg-stone-tile">
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
        <h3 className={cn("mt-6 text-[17px] leading-24 font-semibold tracking-snug whitespace-nowrap", !won && "text-muted")}>{lot.title}</h3>
        <p className="mt-8 flex items-baseline gap-8">
          <b className="font-mono text-[24px] leading-32 font-medium tracking-[-.03em]">
            <Money cents={lot.paidCents} />
          </b>
          <span className="text-13.5 text-muted">{won && phase === "pending" ? "to pay" : "paid"}</span>
        </p>
        <p className="mt-8 flex h-22 items-center gap-8 text-13.5 whitespace-nowrap text-ink2">
          {by?.glim && <Orb size={22} />}
          {by && (
            <span>
              <Amount parts={by.parts} />
            </span>
          )}
        </p>
        <p className="mt-16 flex justify-between border-t border-line pt-12 text-12.5 leading-18 whitespace-nowrap text-muted">
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
    <div className="mt-24">
      {say && view.glim && (
        <div className="flex items-center gap-24 border-t border-line py-16 last:border-b">
          <div className="flex w-190 flex-none items-center gap-12">
            <Orb size={38} />
            <div>
              <b className="block text-15 leading-20 font-semibold">Glim</b>
              <span className="mt-1 flex items-center gap-6 text-12 leading-16 whitespace-nowrap text-muted">
                <i className="block size-7 rounded-full bg-muted" />
                Off duty since {formatClockTime(view.glim.offDutyAt, timeZone)}
              </span>
            </div>
          </div>
          <p className="text-15 leading-22">
            <span className="block whitespace-nowrap">{say[0]}</span>
            {say[1] && <span className="block whitespace-nowrap">{say[1]}</span>}
          </p>
        </div>
      )}
      {others.map((lot) => (
        <div key={lot.lotId} className="flex items-center gap-24 border-t border-line py-16 whitespace-nowrap last:border-b">
          <div className="flex w-190 flex-none items-center gap-12">
            <StatusPill status="closed">Not won</StatusPill>
          </div>
          <div>
            <span className="block font-mono text-11 leading-14 tracking-caps text-muted uppercase">
              Lot {formatLotNumber(lot.number)} · {CATEGORY_LABELS[lot.category]}
            </span>
            <span className="mt-4 block text-14 leading-20 font-medium text-ink2">{lot.title}</span>
          </div>
          <p className="ml-auto text-right">
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
    <p className="flex h-20 items-center justify-between text-13 whitespace-nowrap text-muted [&+&]:mt-4">
      <span>{label}</span>
      {children}
    </p>
  );
}

const mono = "font-mono text-12.5 text-ink";

function ReceiptPanel({ view, links }: { view: ReceiptView; links: GuestLinks }) {
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
    <aside className="flex flex-col rounded-24 bg-surface px-32 py-28">
      <div className="font-mono text-11.5 tracking-caps text-muted uppercase">
        <p className="flex h-26 items-center justify-between leading-26">
          <span className="font-medium text-ink">{receiptTitle(phase, view.receipt?.number ?? null)}</span>
          <span className="inline-flex h-26 items-center rounded-full bg-ink px-11 text-11 font-medium tracking-status whitespace-nowrap text-white">
            {SANDBOX_STAMP}
          </span>
        </p>
        <p className="mt-4 flex justify-between leading-16">
          <span>{receiptDate(dated, tz, "short")}</span>
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
            <b className="block text-16 leading-22 font-semibold">
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

      <div className="mt-24 flex items-baseline justify-between whitespace-nowrap">
        <span className="flex items-baseline gap-8 text-14 text-muted">
          <b className="font-mono text-[48px] leading-52 font-medium tracking-display text-ink">
            <Money cents={view.payCents} />
          </b>
          {settledFigures ? "paid with PayPal" : "to pay with PayPal"}
        </span>
        <span className="flex items-baseline gap-8 text-14 text-muted">
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
      <p className="mt-12 text-13 leading-20 whitespace-nowrap text-ink2">
        <span className="block">{capFirst}</span>
        <span className="block">{capSecond}</span>
      </p>
      <p className="mt-4 text-12.5 leading-18 whitespace-nowrap text-muted">
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
          <p className="mt-8 text-13 leading-20 whitespace-nowrap text-ink2">Only what you pay above an item’s estimated value is tax-deductible.</p>
          {paid && (
            <p className="mt-8 text-12 leading-18 text-muted">
              <span className="block whitespace-nowrap">{charityFirst}</span>
              {charitySecond && <span className="block whitespace-nowrap">{charitySecond}</span>}
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
            <div className="mt-20 flex items-center gap-8">
              {paid ? (
                <>
                  <Link
                    href={receiptPdfHref(links)}
                    className="flex h-48 flex-1 items-center justify-between gap-10 rounded-16 bg-lime pr-16 pl-20 text-15 font-semibold whitespace-nowrap text-ink"
                  >
                    Download receipt
                    <span className="flex items-center gap-10">
                      <small className="font-mono text-11 font-medium tracking-label">PDF</small>
                      <DownloadIcon size={18} />
                    </span>
                  </Link>
                  <a
                    href={emailHref(view)}
                    className="flex h-48 items-center gap-8 pl-16 text-14 font-medium whitespace-nowrap text-ink"
                  >
                    <MailIcon size={17} />
                    Email me a copy
                  </a>
                </>
              ) : (
                <span
                  role="button"
                  aria-disabled="true"
                  className="flex h-48 flex-1 items-center justify-between gap-10 rounded-16 bg-white pr-16 pl-20 text-15 font-semibold whitespace-nowrap text-muted"
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
    </aside>
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
