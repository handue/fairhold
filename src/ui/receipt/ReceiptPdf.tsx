import Link from "next/link";
import { Fragment } from "react";

import { paypalIdOrNull } from "@/server/paypal/simulated-ids";
import type { ReceiptView } from "@/server/queries/receipt-view";

import { formatClockTime, formatLotNumber, formatPaddleNumber, formatUsd } from "../format";
import { LockIcon } from "../icons";
import { PaddleMark } from "../PaddleMark";
import { HeartLineIcon } from "../paddle/icons";
import { lotClockTime } from "../paddle/time";
import type { GuestLinks } from "../routes";

import { bidByText, captionLines, charityLines, receiptDate, receiptFileName } from "./copy";
import { DownloadPdfButton } from "./DownloadPdfButton";
import { receiptHref } from "./receipt-href";
import "./receipt-pdf.css";

/** A mono amount with 25b's tightened comma. */
function Amount({ cents }: { cents: number }) {
  return formatUsd(cents)
    .split(",")
    .map((group, index) => (
      <Fragment key={index}>
        {index > 0 && <span className="cm">,</span>}
        {group}
      </Fragment>
    ));
}

const WATERMARK_LINES = 6;

/**
 * 25b: what Download receipt gives a winner, one US Letter page that must never pass for a real
 * receipt. Two ink bands, a watermark over the figures, "Sandbox receipt" in the number, the charity's
 * details labeled as placeholders, and the marker in the file name and title.
 */
export function ReceiptPdfPage({ view, links }: { view: ReceiptView; links: GuestLinks }) {
  const receipt = view.receipt;
  if (!receipt) return null;
  const tz = view.event.timeZone;
  const [capFirst, capSecond] = captionLines(view);
  const [charityFirst, charitySecond] = charityLines(view.event);
  const holdAt = view.hold?.authorizedAt ? ` at ${formatClockTime(view.hold.authorizedAt, tz)}` : "";
  const notWon = view.notWon;

  return (
    <div className="fh-pdf-stage">
      <div className="fh-pdf-controls mb-24 flex w-816 items-center justify-between">
        <Link href={receiptHref(links)} className="text-14 font-medium text-ink2">
          Back to your receipt
        </Link>
        <DownloadPdfButton fileName={receiptFileName(receipt.number)} />
      </div>

      <div className="fh-pdf" role="img" aria-label="Receipt PDF, marked Sandbox demo, not a tax document">
        <div className="bandp top mono">
          <span>Sandbox demo · not a tax document</span>
          <span className="soft">No real money moved</span>
        </div>

        <div className="sheetp">
          <div className="phead">
            <div className="brand">
              <PaddleMark tone="brand" size={24} />
              {view.event.name}
            </div>
            <span className="eyebrow mono rid">Sandbox receipt {receipt.number}</span>
          </div>
          <p className="eyebrow mono pmeta">
            <span>{receiptDate(view.event.closesAt, tz, "long")}</span>
            <span>
              Paddle {formatPaddleNumber(view.viewer.paddleNumber)} · {view.viewer.firstName}
            </span>
          </p>
          <p className="thanks">Thank you, {view.viewer.firstName}.</p>
          <p className="lede">
            <HeartLineIcon size={15} className="text-muted" />
            Your winning bids support {view.event.charityName}.
          </p>

          <div className="money">
            {view.hold && (
              <div className="hold">
                <span className="lock">
                  <LockIcon size={18} />
                </span>
                <div>
                  <b>
                    {formatUsd(view.hold.cents)} held with PayPal{holdAt}
                  </b>
                  <span className="sub">{view.glim ? "Your bids and Glim’s stayed within it." : "Your bids stayed within it."}</span>
                </div>
              </div>
            )}
            <div className="fig hero">
              <span className="big">
                <b className="mono">
                  <Amount cents={view.payCents} />
                </b>
                paid with PayPal
              </span>
              <span className="sm">
                <b className="mono">
                  <Amount cents={view.releaseCents} />
                </b>
                released
              </span>
            </div>
            <div className="bar" aria-hidden="true">
              {view.payCents > 0 && <i className="k" style={{ flex: `${view.payCents} 1 0` }} />}
              {view.releaseCents > 0 && <i className="g" style={{ flex: `${view.releaseCents} 1 0` }} />}
            </div>
            <p className="cap">
              <span>{capFirst}</span>
              <span>{capSecond}</span>
            </p>
            <p className="note">Some banks take a few days to remove a released hold.</p>
          </div>

          <div className="items">
            <div className="ir ih mono">
              <span>Lot</span>
              <span className="n">Paid</span>
              <span className="n">Estimated value</span>
              <span className="n">Tax-deductible</span>
            </div>
            {view.won.map((lot) => {
              const by = bidByText(lot);
              const won = lot.closedAt === null ? null : `Won at ${lotClockTime(lot.closedAt, tz)}`;
              return (
                <div key={lot.lotId} className="ir it">
                  <div>
                    <b>
                      Lot {formatLotNumber(lot.number)} · {lot.title}
                    </b>
                    <small>{[won, by].filter(Boolean).join(" · ")}</small>
                  </div>
                  <span className="n p mono">
                    <Amount cents={lot.paidCents} />
                  </span>
                  <span className="n e mono">{lot.estimatedValueCents === null ? "Not set" : <Amount cents={lot.estimatedValueCents} />}</span>
                  <span className="n mono">
                    <Amount cents={lot.deductibleCents} />
                  </span>
                </div>
              );
            })}
            <div className="ir itot">
              <span className="t mono">Total</span>
              <span className="n mono">
                <Amount cents={view.payCents} />
              </span>
              <span />
              <span className="n mono">
                <Amount cents={view.deductibleCents} />
              </span>
            </div>
          </div>
          {notWon.map((lot) => (
            <p key={lot.lotId} className="notwon">
              Lot {formatLotNumber(lot.number)}, {lot.title}: not won, never charged.
            </p>
          ))}

          <div className="two">
            <div>
              <div className="fig">
                <span className="sm">
                  <b className="mono">
                    <Amount cents={view.deductibleCents} />
                  </b>
                  tax-deductible
                </span>
              </div>
              <p className="why">Only what you pay above an item’s estimated value is tax-deductible.</p>
              <p className="disc">
                <span>{charityFirst}</span>
                {charitySecond && <span>{charitySecond}</span>}
              </p>
            </div>
            <div>
              <p className="det">
                <span>PayPal transaction ID</span>
                <span className="mono">{paypalIdOrNull(receipt.captureId) ?? "Simulated"}</span>
              </p>
              {view.event.statementLabel && (
                <p className="det">
                  <span>On your statement</span>
                  <span className="mono">{view.event.statementLabel}</span>
                </p>
              )}
              {view.event.pickupNote && <p className="pick">{view.event.pickupNote}</p>}
            </div>
          </div>
        </div>

        <div className="wm mono" aria-hidden="true">
          {Array.from({ length: WATERMARK_LINES }, (_, index) => (
            <span key={index} className="mono">
              SANDBOX DEMO
            </span>
          ))}
        </div>
        <div className="bandp bot mono">
          <span>Sandbox demo · not a tax document</span>
          <span className="soft">Page 1 of 1</span>
        </div>
      </div>
    </div>
  );
}
