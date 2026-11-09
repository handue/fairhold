import type { LedgerView, SettlementChecks } from "@/server/settlement/types";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { ArrowRightIcon, LockIcon } from "@/ui/icons";
import { Money } from "@/ui/Money";
import { Orb } from "@/ui/Orb";
import { formatPaddleNumber, formatUsd } from "@/ui/format";

import { checkRows, checksHeading, glimLine, railAction, railCopy, type CheckMark } from "./ledger-model";

function CheckMarkIcon({ mark }: { mark: CheckMark }) {
  return (
    <span className="flex size-22 flex-none items-center justify-center rounded-full bg-white">
      {mark === "passed" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      )}
      {mark === "failed" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      )}
    </span>
  );
}

const MONO_CAPS = "font-mono text-11.5 leading-16 tracking-caps uppercase";

interface LedgerRailProps {
  view: LedgerView;
  checks: SettlementChecks;
  checking: boolean;
  busy: boolean;
  error: string | null;
  onCharge: () => void;
  onRetryAll: () => void;
  onCheckAgain: () => void;
}

/** 12's decision rail: what is held, what will be charged and released, the checks, the one action. */
export function LedgerRail({ view, checks, checking, busy, error, onCharge, onRetryAll, onCheckAgain }: LedgerRailProps) {
  const copy = railCopy({ ...view, checks });
  const action = railAction(view, checks, busy || checking);
  const glim = glimLine(view);
  const captures = view.rows.filter((row) => row.item?.paypalCaptureId && row.item.status === "succeeded");

  return (
    <aside aria-label={copy.title} className="flex min-w-0 flex-col rounded-24 bg-surface p-28">
      <span className={cn("block text-muted", MONO_CAPS)}>{copy.eyebrow}</span>
      <h1 className="mt-8 text-[24px] leading-32 font-semibold tracking-title whitespace-nowrap">{copy.title}</h1>

      <div className="mt-20 flex items-center gap-14">
        <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white">
          <LockIcon size={18} />
        </span>
        <div className="min-w-0">
          <b className="block text-16 leading-22 font-semibold whitespace-nowrap">{copy.holdLine}</b>
          <span className="mt-2 block text-13 leading-18 whitespace-nowrap text-muted">{copy.holdSub}</span>
        </div>
      </div>

      <div className="mt-24 grid grid-cols-[auto_auto] items-baseline justify-between whitespace-nowrap">
        <b className="font-mono text-[48px] leading-52 font-medium tracking-display text-ink">
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
        className="mt-12 flex h-10 gap-6"
      >
        <i className="block h-full rounded-[5px] bg-ink" style={{ flex: `${copy.left.cents} 1 0` }} />
        <i className="block h-full rounded-[5px] bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" style={{ flex: `${copy.right.cents} 1 0` }} />
      </div>
      <p className="mt-12 text-13 leading-20 whitespace-nowrap text-ink2">
        <span className="block">{copy.caption[0]}</span>
        <span className="block">{copy.caption[1]}</span>
      </p>
      {copy.note && <p className="mt-4 text-12.5 leading-18 whitespace-nowrap text-muted">{copy.note}</p>}

      <div className="mt-24 border-t border-[rgba(11,11,12,.08)] pt-20">
        <div className="flex items-center justify-between">
          <span className={cn("text-muted", MONO_CAPS)}>Checks</span>
          <span className={cn("font-medium text-ink", MONO_CAPS)}>{checksHeading(view.phase, checks, checking)}</span>
        </div>
        <ul className="mt-12">
          {checkRows(view, checks).map((check) => (
            <li key={check.key} className="mt-8 first:mt-0">
              <span className="flex h-22 items-center gap-10 text-14 whitespace-nowrap text-ink">
                <CheckMarkIcon mark={check.mark} />
                {check.label}
              </span>
              {check.details.map((detail) => (
                <span key={detail} className="mt-2 ml-32 block text-12.5 leading-18 whitespace-nowrap text-muted">
                  {detail}
                </span>
              ))}
            </li>
          ))}
        </ul>
        {glim && (
          <p className="mt-12 flex items-center gap-10 text-13.5 leading-22 whitespace-nowrap text-ink2">
            <Orb size={22} />
            {glim}
          </p>
        )}
      </div>

      <div className="flex-[1_0_16px]" />
      {view.phase === "charged" && captures.length > 0 && (
        <div className="border-t border-[rgba(11,11,12,.08)] pt-20">
          {captures.slice(0, 3).map((row) => (
            <p key={row.paddleId} className="flex justify-between gap-12 text-12.5 leading-18 whitespace-nowrap text-muted">
              <span>Paddle {formatPaddleNumber(row.paddleNumber)} · PayPal transaction ID</span>
              <span className="font-mono text-ink">{row.item?.paypalCaptureId}</span>
            </p>
          ))}
        </div>
      )}
      {action && (
        <div className="border-t border-[rgba(11,11,12,.08)] pt-20">
          {error && (
            <p role="alert" className="mb-12 text-12.5 leading-18 text-ink2">
              {error}
            </p>
          )}
          <div className="flex gap-8">
            {view.phase === "ready" && !checking && checks.passed !== true && (
              <Button variant="quiet" size={48} onClick={onCheckAgain} className="flex-none">
                Check again
              </Button>
            )}
            <Button
              variant="lime"
              size={48}
              fullWidth
              disabled={!action.enabled}
              onClick={action.kind === "retry" ? onRetryAll : onCharge}
              className="min-w-0 justify-between disabled:cursor-default disabled:opacity-45"
            >
              {action.label}
              {action.kind !== "none" && <ArrowRightIcon size={18} />}
            </Button>
          </div>
        </div>
      )}
    </aside>
  );
}
