import Link from "next/link";
import type { ReactNode } from "react";

import type { EventCard, HoldCardView, PlanCardItemView, PlanCardView } from "@/server/chat/types";

import { cn } from "../cn";
import { formatUsd } from "../format";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";

/**
 * 07's bubbles and cards, ported from mockups/07-web-agent-chat.html value for value. States the
 * mockup doesn't draw use its parts and plain words until design/22 is approved; the report lists them.
 */
export function GlimBubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-300 self-start rounded-[18px_18px_18px_6px] bg-white px-14 py-11 text-14 leading-[1.45] break-words shadow-[0_1px_0_rgba(11,11,12,.04)]">
      {children}
    </div>
  );
}

export function GuestBubble({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-290 self-end rounded-[18px_18px_6px_18px] bg-ink px-14 py-11 text-14 leading-[1.45] break-words text-white">
      {children}
    </div>
  );
}

/** Priority 1 is ink and 2 lime, as drawn; a third lot and below are the warm grey the mockup has no need of. */
function itemTone(priority: number): string {
  if (priority === 1) return "bg-ink text-white";
  if (priority === 2) return "bg-lime text-ink inset-ring inset-ring-lime-edge";
  return "bg-closed text-ink2";
}

function PlanItem({ item }: { item: PlanCardItemView }) {
  return (
    <div className="mt-12 grid grid-cols-[22px_1fr_auto] items-center gap-10">
      <span className={cn("flex size-22 items-center justify-center rounded-full font-mono text-11 font-semibold", itemTone(item.priority))}>
        {item.priority}
      </span>
      <div className="min-w-0">
        <div className="truncate text-13.5 font-medium">{item.title}</div>
        <div className="mt-1 text-11.5 text-muted">{item.statusText}</div>
      </div>
      <div className="text-right font-mono text-13 font-medium">
        <Money cents={item.maxCents} />
        <small className="block text-10.5 font-normal tracking-[.04em] text-muted">MAX</small>
      </div>
    </div>
  );
}

const CARD_BUTTON = "flex h-40 cursor-pointer items-center justify-center rounded-12 text-13.5 font-semibold text-ink disabled:cursor-default disabled:opacity-60";
const QUIET_BUTTON = cn(CARD_BUTTON, "w-72 border border-line");

export interface PlanCardActions {
  onStart(planId: string): void;
  onEdit(): void;
  onPause(): void;
  onResume(): void;
}

export function PlanCard({ card, busy, actions }: { card: PlanCardView; busy: boolean; actions: PlanCardActions }) {
  return (
    <div className="self-stretch rounded-18 border border-line bg-white p-14">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-11 tracking-label text-muted uppercase">My plan for you</span>
        <b className="font-mono text-15 font-semibold">
          <Money cents={card.budgetCents} />
        </b>
      </div>
      <div aria-hidden="true" className="mt-10 flex h-8 gap-2 overflow-hidden rounded-4">
        {card.items.map((item) => (
          <i key={item.lotId} className={cn("block h-full", itemTone(item.priority))} style={{ width: `${item.sharePercent}%` }} />
        ))}
      </div>
      {card.items.map((item) => (
        <PlanItem key={item.lotId} item={item} />
      ))}
      {/* The "ON MY OWN" block (V1, design/21) goes here, and must land with src/server/chat/switch.ts. */}
      {card.state === "proposed" && (
        <div className="mt-14 flex gap-8">
          <button type="button" disabled={busy} onClick={() => actions.onStart(card.planId)} className={cn(CARD_BUTTON, "flex-1 bg-lime")}>
            Start bidding
          </button>
          <button type="button" disabled={busy} onClick={actions.onEdit} className={QUIET_BUTTON}>
            Edit
          </button>
        </div>
      )}
      {(card.state === "running" || card.state === "paused") && (
        <div className="mt-14 flex items-center gap-8">
          <span className="flex-1 text-11.5 text-muted">{card.stateLine}</span>
          {card.state === "running" ? (
            <button type="button" disabled={busy} onClick={actions.onPause} className={QUIET_BUTTON}>
              Pause
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={actions.onResume} className={QUIET_BUTTON}>
              Resume
            </button>
          )}
          <button type="button" disabled={busy} onClick={actions.onEdit} className={QUIET_BUTTON}>
            Edit
          </button>
        </div>
      )}
      {card.state === "over" && card.stateLine && <p className="mt-10 text-11.5 text-muted">{card.stateLine}</p>}
    </div>
  );
}

function EventChip({ chip }: { chip: NonNullable<EventCard["chip"]> }) {
  if (chip.kind === "winning") {
    return (
      <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-lime pr-9 pl-6 text-11.5 font-semibold">
        <PaddleMark tone="winning" size={13} />
        Winning · {formatUsd(chip.amountCents)}
      </span>
    );
  }
  return (
    <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-closed pr-9 pl-6 text-11.5 font-semibold text-ink2">
      <PaddleMark tone="closed" size={13} />
      Closed
    </span>
  );
}

export function EventCardView({ card }: { card: EventCard }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-10 self-stretch rounded-16 bg-white px-14 py-12">
      <Orb size={26} />
      <div>
        <div className="font-mono text-10.5 tracking-[.06em] text-muted">{card.eyebrow}</div>
        <p className="mt-2 text-13.5 leading-[1.45]">{card.line}</p>
        {card.chip && <EventChip chip={card.chip} />}
      </div>
    </div>
  );
}

/** Glim's raise offer: 10's words on 07's lime button, opening 09 in raise mode with the amount chosen. */
export function HoldCard({ card, href, onOpen }: { card: HoldCardView; href: string; onOpen(): void }) {
  return (
    <div className="self-stretch rounded-18 border border-line bg-white p-14">
      <Link href={href} onClick={onOpen} prefetch={false} className={cn(CARD_BUTTON, "gap-6 bg-lime")}>
        {card.label}
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17L17 7" />
          <path d="M8 7h9v9" />
        </svg>
      </Link>
      <p className="mt-10 text-11.5 text-muted">{card.note}</p>
    </div>
  );
}
