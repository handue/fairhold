"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import type {
  ClosingCardView,
  EventCard,
  HoldCardView,
  PlanCardItemView,
  PlanCardView,
  PlanEditItemView,
  SetPowerCardView,
} from "@/server/chat/types";
import type { PlanCardAutopilotLines } from "@/server/glim/autopilot/copy";

import { cn } from "../cn";
import { formatUsd } from "../format";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";

import { ArrowRight, ArrowUpRight, BubbleMark, HeartMark, LockMark } from "./marks";

/**
 * 07's bubbles and cards, ported from mockups/07-web-agent-chat.html value for value, with the states
 * design/21 (V1–V3) and design/22 add to them, from those boards' own measures.
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

/** The bright dot moves left to right, one step at a time; each step is design/22 #3's frame (1, .5, .2) turned. */
const TYPING_CSS = `@keyframes glim-dot{0%,100%{opacity:1}33.3%{opacity:.2}66.6%{opacity:.5}}`;
const DOT_DELAYS = ["0s", "-0.8s", "-0.4s"];

/** design/22 #3: Glim's bubble with three dots pulsing in turn, until the words stream in. */
export function TypingBubble() {
  return (
    <div
      role="status"
      aria-label="Glim is thinking"
      className="flex h-42 items-center gap-5 self-start rounded-[18px_18px_18px_6px] bg-white px-16 shadow-[0_1px_0_rgba(11,11,12,.04)]"
    >
      <style href="glim-typing" precedence="default">
        {TYPING_CSS}
      </style>
      {[0, 1, 2].map((dot) => (
        <i
          key={dot}
          className="block size-6 rounded-3 bg-ink"
          style={{ opacity: [1, 0.5, 0.2][dot], animation: "glim-dot 1.2s steps(1, end) infinite", animationDelay: DOT_DELAYS[dot] }}
        />
      ))}
    </div>
  );
}

/** Priority 1 is ink and 2 lime, as drawn; a third lot and below are the warm grey the mockup has no need of. */
function itemTone(priority: number): string {
  if (priority === 1) return "bg-ink text-white";
  if (priority === 2) return "bg-lime text-ink inset-ring inset-ring-lime-edge";
  return "bg-closed text-ink2";
}

function PlanNumber({ priority }: { priority: number }) {
  return (
    <span className={cn("flex size-22 items-center justify-center rounded-full font-mono text-11 font-semibold", itemTone(priority))}>
      {priority}
    </span>
  );
}

function PlanItem({ item }: { item: PlanCardItemView }) {
  return (
    <div className="mt-12 grid grid-cols-[22px_1fr_auto] items-center gap-10">
      <PlanNumber priority={item.priority} />
      <div className="min-w-0">
        <div className="truncate text-13.5 font-medium">{item.title}</div>
        <div className="mt-1 text-11.5 text-muted">{item.statusText}</div>
      </div>
      <div className="text-right font-mono text-13 font-medium">
        <Money cents={item.maxCents} />
        <small className="block text-10.5 font-normal tracking-[.04em] text-muted">
          {item.wasCents === null ? "MAX" : `WAS ${formatUsd(item.wasCents)}`}
        </small>
      </div>
    </div>
  );
}

function AllocationBar({ shares }: { shares: { key: string | number; priority: number; percent: number }[] }) {
  return (
    <div aria-hidden="true" className="mt-10 flex h-8 gap-2 overflow-hidden rounded-4">
      {shares.map((share) => (
        <i key={share.key} className={cn("block h-full", itemTone(share.priority))} style={{ width: `${share.percent}%` }} />
      ))}
    </div>
  );
}

/** V1, design/21: what Glim may do on its own once Start bidding is pressed, between the lots and the buttons. */
function OnMyOwn({ lines }: { lines: PlanCardAutopilotLines }) {
  return (
    <div className="mt-14 border-t border-line pt-12">
      <p className="font-mono text-11 leading-14 tracking-label text-muted uppercase">On my own</p>
      <p className="mt-6 text-13 leading-19 text-pretty">{lines.body}</p>
      {lines.backups.map((backup) => (
        <div key={backup.lotId} className="mt-10 grid grid-cols-[22px_1fr_auto] items-center gap-10">
          <span aria-hidden="true" className="flex size-22 items-center justify-center rounded-full bg-closed">
            {backup.sourceLabel === "You hearted it" ? <HeartMark /> : <BubbleMark />}
          </span>
          <div className="min-w-0">
            <div className="truncate text-13.5 font-medium">{backup.title}</div>
            <div className="mt-1 text-11.5 text-muted">{backup.statusText}</div>
          </div>
          <div className="text-right text-11.5 whitespace-nowrap text-ink2">{backup.sourceLabel}</div>
        </div>
      ))}
      <p className="mt-10 flex items-start gap-6 text-11.5 leading-16 text-pretty text-ink2">
        <LockMark className="mt-1.5 flex-none" />
        <span>{lines.rules}</span>
      </p>
    </div>
  );
}

/** 44px tall on a phone, a thumb's height. */
const CARD_BUTTON = "flex h-40 cursor-pointer items-center justify-center rounded-12 text-13.5 font-semibold text-ink disabled:cursor-default max-md:h-44";
const QUIET_BUTTON = cn(CARD_BUTTON, "w-72 flex-none border border-line disabled:opacity-60");
/** design/22 #22 and design/21 #10: where a button was, a quiet label that says how things stand. */
const QUIET_LABEL = "flex h-40 flex-1 items-center justify-center rounded-12 bg-surface text-13.5 font-semibold text-muted max-md:h-44";

export interface PlanCardActions {
  onStart(planId: string): void;
  /** Done in the editor: the server answers with a new card, or with why it can't. */
  onEditDone(planId: string, items: { lotNumber: number; maxCents: number }[]): Promise<string | null>;
}

export function PlanCard({
  card,
  busy,
  actions,
  editing,
  setEditing,
}: {
  card: PlanCardView;
  busy: boolean;
  actions: PlanCardActions;
  /** The panel keeps which card is open as fields, so 10's "Edit plan" can open the running one. */
  editing: boolean;
  setEditing(editing: boolean): void;
}) {
  const canEdit = card.edit !== null;

  if (editing && card.edit) {
    return (
      <PlanEditor
        card={card}
        edit={card.edit.items}
        holdCents={card.edit.holdCents}
        outsideCents={card.edit.outsideCents}
        busy={busy}
        onCancel={() => setEditing(false)}
        onDone={async (items) => {
          const failure = await actions.onEditDone(card.edit?.planId ?? card.planId, items);
          if (failure === null) setEditing(false);
          return failure;
        }}
      />
    );
  }

  return (
    <div data-card="plan" className="self-stretch rounded-18 border border-line bg-white p-14">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-11 tracking-label text-muted uppercase">{card.eyebrow}</span>
        <b className="font-mono text-15 font-semibold">
          <Money cents={card.budgetCents} />
        </b>
      </div>
      <AllocationBar shares={card.items.map((item) => ({ key: item.lotId, priority: item.priority, percent: item.sharePercent }))} />
      {card.items.map((item) => (
        <PlanItem key={item.lotId} item={item} />
      ))}
      {card.onMyOwn && <OnMyOwn lines={card.onMyOwn} />}
      {card.state === "proposed" && (
        <div className="mt-14 flex gap-8">
          <button type="button" disabled={busy} onClick={() => actions.onStart(card.planId)} className={cn(CARD_BUTTON, "flex-1 bg-lime disabled:opacity-60")}>
            {card.startLabel}
          </button>
          {canEdit && (
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className={QUIET_BUTTON}>
              Edit
            </button>
          )}
        </div>
      )}
      {card.state !== "proposed" && card.stateLine && (
        <div className="mt-14 flex gap-8">
          <span className={QUIET_LABEL}>{card.stateLine}</span>
          {canEdit && (
            <button type="button" disabled={busy} onClick={() => setEditing(true)} className={QUIET_BUTTON}>
              Edit
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface EditRow extends PlanEditItemView {
  /** What the field holds, in whole dollars as typed; "" while empty. */
  draft: string;
}

const dollarsOf = (draft: string): number | null => (/^\d{1,7}$/.test(draft) ? Number(draft) * 100 : null);

/** design/22 #7 and #8: each MAX opens as a field, × takes a lot out, and Done waits until the plan fits. */
function PlanEditor(props: {
  card: PlanCardView;
  edit: PlanEditItemView[];
  holdCents: number;
  outsideCents: number;
  busy: boolean;
  onCancel(): void;
  onDone(items: { lotNumber: number; maxCents: number }[]): Promise<string | null>;
}) {
  const { card, edit, holdCents, outsideCents, busy } = props;
  const [rows, setRows] = useState<EditRow[]>(() => edit.map((item) => ({ ...item, draft: String(Math.round(item.maxCents / 100)) })));
  const [focused, setFocused] = useState<number | null>(edit[0]?.lotNumber ?? null);
  const [serverNotice, setServerNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const removed = edit.filter((item) => !rows.some((row) => row.lotNumber === item.lotNumber));
  const availableCents = holdCents - outsideCents - removed.reduce((sum, item) => sum + item.withoutPlanCents, 0);
  const amounts = rows.map((row) => dollarsOf(row.draft));
  const totalCents = amounts.reduce<number>((sum, cents) => sum + (cents ?? 0), 0);
  const low = rows.find((row, index) => amounts[index] === null || (amounts[index] ?? 0) < row.minCents);
  const over = totalCents > availableCents;
  const ready = rows.length > 0 && !low && !over && !busy && !sending;
  const scale = Math.max(totalCents, card.budgetCents, 1);

  let notice: { title: ReactNode; line: ReactNode } | null = null;
  if (over) {
    notice = {
      title: (
        <>
          This plan needs <span className="font-mono">{formatUsd(totalCents)}</span>
        </>
      ),
      line: (
        <>
          You have <span className="font-mono">{formatUsd(Math.max(0, availableCents))}</span> of bidding power.
        </>
      ),
    };
  } else if (low) {
    notice = {
      title: (
        <>
          {low.title} needs at least <span className="font-mono">{formatUsd(low.minCents)}</span>
        </>
      ),
      line: low.minIsOwnBid ? "That’s your bid there." : "That’s its next bid.",
    };
  } else if (serverNotice) {
    notice = { title: serverNotice, line: null };
  }

  async function done() {
    if (!ready) return;
    setSending(true);
    const failure = await props.onDone(rows.map((row, index) => ({ lotNumber: row.lotNumber, maxCents: amounts[index] ?? 0 })));
    setSending(false);
    setServerNotice(failure);
  }

  return (
    <div className="self-stretch rounded-18 border border-line bg-white p-14">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-11 tracking-label text-muted uppercase">{card.eyebrow}</span>
        <b className="font-mono text-15 font-semibold">
          <Money cents={card.budgetCents} />
        </b>
      </div>
      <AllocationBar
        shares={rows.map((row, index) => ({ key: row.lotNumber, priority: index + 1, percent: ((amounts[index] ?? 0) / scale) * 100 }))}
      />
      {rows.map((row, index) => (
        <div
          key={row.lotNumber}
          className="mt-12 grid grid-cols-[22px_1fr_92px_16px] items-center gap-10 max-md:grid-cols-[22px_minmax(0,1fr)_40px] max-md:gap-y-8"
        >
          <PlanNumber priority={index + 1} />
          <div className="min-w-0">
            <div className="truncate text-13.5 font-medium">{row.title}</div>
            <div className="mt-1 text-11.5 text-muted">{row.statusText}</div>
          </div>
          <label
            className={cn(
              "flex h-36 cursor-text items-center rounded-[10px] bg-white px-10 font-mono text-13 font-medium",
              // A phone: its own row under the lot, and 16px so iOS doesn't zoom in on focus.
              "max-md:col-span-2 max-md:col-start-2 max-md:row-start-2 max-md:h-44 max-md:px-12 max-md:text-16",
              focused === row.lotNumber ? "inset-ring-[1.5px] inset-ring-ink" : "inset-ring inset-ring-line",
            )}
          >
            <span aria-hidden="true">$</span>
            <input
              value={row.draft}
              inputMode="numeric"
              autoFocus={index === 0}
              aria-label={`${row.title} maximum, in whole dollars`}
              onFocus={() => setFocused(row.lotNumber)}
              onBlur={() => setFocused((current) => (current === row.lotNumber ? null : current))}
              onChange={(event) => {
                const draft = event.target.value.replace(/[^\d]/g, "").slice(0, 7);
                setServerNotice(null);
                setRows((current) => current.map((entry) => (entry.lotNumber === row.lotNumber ? { ...entry, draft } : entry)));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void done();
              }}
              className="w-0 min-w-0 flex-1 bg-transparent outline-none"
            />
            <small className="ml-auto text-10.5 font-normal tracking-[.04em] text-muted">MAX</small>
          </label>
          <button
            type="button"
            aria-label={`Take ${row.title} out`}
            onClick={() => {
              setServerNotice(null);
              setRows((current) => current.filter((entry) => entry.lotNumber !== row.lotNumber));
            }}
            className="flex size-16 cursor-pointer items-center justify-center text-muted max-md:col-start-3 max-md:row-start-1 max-md:-mr-12 max-md:size-40 max-md:justify-self-end"
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
      {notice && (
        <div role="status" className="mt-12 rounded-12 bg-surface px-12 py-10">
          <p className="text-13.5 leading-20 font-semibold">{notice.title}</p>
          {notice.line && <p className="mt-1 text-11.5 leading-16 text-muted">{notice.line}</p>}
        </div>
      )}
      <div className={cn("flex gap-8", notice ? "mt-10" : "mt-14")}>
        <button
          type="button"
          disabled={!ready}
          onClick={() => void done()}
          className={cn(CARD_BUTTON, "flex-1", ready ? "bg-lime" : "bg-surface text-muted")}
        >
          Done
        </button>
        <button type="button" onClick={props.onCancel} className={QUIET_BUTTON}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function EventChip({ chip }: { chip: NonNullable<EventCard["chip"]> }) {
  if (chip.kind === "closed") {
    return (
      <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-closed pr-9 pl-6 text-11.5 font-semibold text-ink2">
        <PaddleMark tone="closed" size={13} />
        Closed
      </span>
    );
  }
  return (
    <span className="mt-8 inline-flex h-24 items-center gap-5 rounded-12 bg-lime pr-9 pl-6 text-11.5 font-semibold">
      <PaddleMark tone="winning" size={13} />
      {chip.kind === "won" ? "Won" : "Winning"} · {formatUsd(chip.amountCents)}
    </span>
  );
}

/** 07's event card: the mini orb, a mono eyebrow, and what follows it. */
export function EventFrame({ eyebrow, children, footer, card = "event" }: { eyebrow: string; children: ReactNode; footer?: ReactNode; card?: string }) {
  return (
    <div data-card={card} className="grid grid-cols-[auto_1fr] items-start gap-10 self-stretch rounded-16 bg-white px-14 py-12">
      <Orb size={26} />
      <div className="min-w-0">
        <div className="font-mono text-10.5 tracking-[.06em] text-muted">{eyebrow}</div>
        {children}
      </div>
      {footer}
    </div>
  );
}

export function EventCardView({ card }: { card: EventCard }) {
  return (
    <EventFrame eyebrow={card.eyebrow}>
      <p className="mt-2 text-13.5 leading-[1.45]">{card.line}</p>
      {card.chip && <EventChip chip={card.chip} />}
    </EventFrame>
  );
}

/** A lime card button (21's raise button): the arrow says where it goes. */
export function LimeButtonLink({ href, label, arrow, onOpen }: { href: string; label: string; arrow: "right" | "up-right"; onOpen?(): void }) {
  return (
    <Link href={href} onClick={onOpen} prefetch={false} className={cn(CARD_BUTTON, "flex-1 gap-6 bg-lime")}>
      {label}
      {arrow === "right" ? <ArrowRight /> : <ArrowUpRight />}
    </Link>
  );
}

/** 07's held line, as a card's note: a lock and one quiet sentence. */
export function HeldNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-10 flex items-start gap-6 text-11.5 leading-16 text-pretty text-muted">
      <LockMark tone="muted" className="mt-1.5 flex-none" />
      <span>{children}</span>
    </p>
  );
}

/** design/22 #5: Glim's raise offer, opening 09 in raise mode with the amount chosen. */
export function HoldCard({ card, href, onOpen }: { card: HoldCardView; href: string; onOpen(): void }) {
  return (
    <div className="self-stretch rounded-18 border border-line bg-white p-14">
      {card.lot && (
        <div className="flex items-baseline justify-between gap-12">
          <span className="truncate font-mono text-11 tracking-label text-muted uppercase">{card.lot.label}</span>
          <b className="font-mono text-15 font-semibold">
            <Money cents={card.lot.amountCents} />
          </b>
        </div>
      )}
      {card.left && (
        <p className={cn("text-13 leading-19 text-ink2", card.lot && "mt-8")}>
          You have <b className="font-mono font-medium text-ink">{formatUsd(card.left.leftCents)}</b> left of{" "}
          <b className="font-mono font-medium text-ink">{formatUsd(card.left.holdCents)}</b>.
        </p>
      )}
      <div className={cn("flex gap-6", (card.lot || card.left) && "mt-12")}>
        <LimeButtonLink href={href} label={card.label} arrow="up-right" onOpen={onOpen} />
      </div>
      <HeldNote>{card.note}</HeldNote>
    </div>
  );
}

/** design/22 #2: no bidding power yet; the button's words are 19's, its note 20's. */
export function SetPowerCard({ card, href, onOpen }: { card: SetPowerCardView; href: string; onOpen(): void }) {
  return (
    <div className="self-stretch rounded-18 border border-line bg-white p-14">
      <div className="flex gap-6">
        <LimeButtonLink href={href} label={card.label} arrow="right" onOpen={onOpen} />
      </div>
      <HeldNote>{card.note}</HeldNote>
    </div>
  );
}

/** design/22 #12: Glim's last card once bidding closes. */
export function ClosingCard({ card, onOpen }: { card: ClosingCardView; onOpen(): void }) {
  return (
    <EventFrame eyebrow={card.eyebrow} card="closing">
      <p className="mt-2 text-13.5 leading-[1.45]">{card.line}</p>
      {card.receipt && (
        <div className="mt-12 flex gap-6">
          <LimeButtonLink href={card.receipt.href} label={card.receipt.label} arrow="right" onOpen={onOpen} />
        </div>
      )}
    </EventFrame>
  );
}
