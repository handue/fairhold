"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import type { ChatCardView, ChatMessageView, ChatStreamFrame, ChatView, QuickReply } from "@/server/chat/types";
import { ERROR_LINE } from "@/server/glim/copy";

import { ApiClientError, apiGet, apiPost } from "../api";
import { cn } from "../cn";
import { onGlimOpen } from "../glim-events";
import { Orb } from "../Orb";
import { joinHref } from "../routes";

import { AutopilotCardView, AutopilotRaiseCardView } from "./AutopilotCards";
import { ClosingCard, EventCardView, GlimBubble, GuestBubble, HoldCard, PlanCard, SetPowerCard, TypingBubble, type PlanCardActions } from "./cards";
import { postChatMessage } from "./frames";
import { GlimLiveUpdates } from "./GlimLiveUpdates";
import { PauseMark, PlayMark, SpinnerMark } from "./marks";
import { setGlimPanelOpen, setGuestTalked, useGlimPanelOpen } from "./panel-state";

/** The chat is for guests: the projector and the organizer's pages show no panel (the scope map cuts it there). */
const PAGES_WITHOUT_GLIM = /^\/e\/[^/]+\/(?:organizer|projector|join)(?:\/|$)/;
const SOMETHING_WENT_WRONG = "Something went wrong. Please try again.";

/**
 * A phone or a touch screen: opening the panel leaves the keyboard down, so Glim's greeting and the
 * quick replies (the one-thumb path) show first rather than an Android keyboard over half the sheet.
 * With a mouse and a keyboard the input takes focus, as approved.
 */
const OPENS_WITHOUT_TYPING = "(max-width: 767px), (pointer: coarse)";
const focusesInputOnOpen = () => !window.matchMedia(OPENS_WITHOUT_TYPING).matches;

interface Turn {
  guestText: string;
  reply: string;
}

/** A line that exists only in this panel: a reply the server didn't store, or why something failed. */
interface LocalLine {
  guestText: string | null;
  reply: string;
}

/** 07: Glim's chat, opened from the corner orb on any guest page. It sits above the orb at 400×704. */
export function GlimPanel({ slug, talked }: { slug: string; talked: boolean }) {
  const pathname = usePathname();
  const allowed = !PAGES_WITHOUT_GLIM.test(pathname);
  const open = useGlimPanelOpen();
  const visible = open && allowed;

  const [view, setView] = useState<ChatView | null>(null);
  const [draft, setDraft] = useState("");
  const [contextLot, setContextLot] = useState<number | null>(null);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [localLines, setLocalLines] = useState<LocalLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  /** The plan card open as fields (design/22 #7), and whether 10's "Edit plan" asked for the running one. */
  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);
  const [editRunningPlan, setEditRunningPlan] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  /** Whether the log keeps its newest line in view when it resizes: until the guest scrolls up to read. */
  const followEnd = useRef(true);
  /** The input takes focus as the panel opens, whatever the screen: a prefill waits for the guest's amount. */
  const focusOnOpen = useRef(false);

  const base = `/api/glim/${encodeURIComponent(slug)}`;

  useEffect(() => setGuestTalked(talked), [talked]);
  useEffect(() => {
    if (!allowed) setGlimPanelOpen(false);
  }, [allowed]);
  useEffect(
    () =>
      onGlimOpen((detail) => {
        setGlimPanelOpen(true);
        if (detail.lotNumber !== undefined) setContextLot(detail.lotNumber);
        if (detail.prefill !== undefined) setDraft(detail.prefill);
        if (detail.edit) setEditRunningPlan(true);
        // 05's "Bid on … for me, up to $" ends where the guest types, so it takes focus on a phone too.
        else if (detail.prefill !== undefined || focusesInputOnOpen()) {
          if (input.current) input.current.focus();
          else focusOnOpen.current = true;
        }
      }),
    [],
  );

  const handleFailure = useCallback(
    (error: unknown, guestText: string | null = null) => {
      if (error instanceof ApiClientError && error.code === "not_joined") {
        // A full load, so every server component reads the new session afterwards.
        window.location.assign(joinHref(slug, window.location.pathname));
        return;
      }
      const reply = error instanceof ApiClientError ? error.message : SOMETHING_WENT_WRONG;
      setLocalLines((lines) => [...lines, { guestText, reply }]);
    },
    [slug],
  );

  const refresh = useCallback(async () => {
    try {
      setView(await apiGet<ChatView>(base));
      setReadFailed(false);
    } catch (error) {
      // A failed read keeps what is on screen, and the next one tries again.
      if (error instanceof ApiClientError && error.code === "not_joined") handleFailure(error);
      else setReadFailed(true);
    }
  }, [base, handleFailure]);

  const watchedLotIds = useMemo(
    () => new Set(view?.messages.flatMap((message) => (message.card?.type === "plan" ? message.card.items.map((item) => item.lotId) : [])) ?? []),
    [view],
  );

  useEffect(() => {
    if (!visible) return;
    if (focusOnOpen.current || focusesInputOnOpen()) input.current?.focus();
    focusOnOpen.current = false;
  }, [visible]);

  // Below 768 the panel is a full-screen sheet. It follows the visual viewport, so the input stays
  // above the on-screen keyboard and the header stays at the top of what the guest can see.
  useEffect(() => {
    const viewport = window.visualViewport;
    const element = sheet.current;
    if (!visible || !viewport || !element) return;
    const fit = () => {
      element.style.setProperty("--glim-sheet-height", `${viewport.height}px`);
      element.style.setProperty("--glim-sheet-top", `${viewport.offsetTop}px`);
    };
    fit();
    viewport.addEventListener("resize", fit);
    viewport.addEventListener("scroll", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      viewport.removeEventListener("scroll", fit);
    };
  }, [visible]);

  // New lines stay in view: the newest message, or the reply as it streams.
  const lineCount = (view?.messages.length ?? 0) + localLines.length;
  const streamedLength = turn?.reply.length ?? -1;
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    followEnd.current = true;
  }, [visible, lineCount, streamedLength]);

  // When the log gets shorter or narrower (a phone's keyboard opening, a phone turned), the newest line
  // stays in view, unless the guest scrolled up to read. Only the guest's own scrolling counts: a
  // resize also moves scrollTop (clamping, scroll anchoring) before the observer hears of it.
  useEffect(() => {
    const element = scroller.current;
    if (!visible || !element || typeof ResizeObserver === "undefined") return;
    let guestScrolling = false;
    const onGuest = () => {
      guestScrolling = true;
    };
    const onScroll = () => {
      if (guestScrolling) followEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    };
    const observer = new ResizeObserver(() => {
      guestScrolling = false;
      if (followEnd.current) element.scrollTop = element.scrollHeight;
    });
    const intents = ["wheel", "touchmove", "keydown"] as const;
    for (const type of intents) element.addEventListener(type, onGuest, { passive: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(element);
    return () => {
      observer.disconnect();
      for (const type of intents) element.removeEventListener(type, onGuest);
      element.removeEventListener("scroll", onScroll);
    };
  }, [visible]);

  const act = useCallback(
    async (path: string) => {
      setBusy(true);
      try {
        setView(await apiPost<ChatView>(`${base}${path}`));
      } catch (error) {
        handleFailure(error);
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [base, handleFailure, refresh],
  );

  /** Done in the plan editor: the new card, or the sentence that says why not, for the editor to show. */
  const editPlan = useCallback(
    async (planId: string, items: { lotNumber: number; maxCents: number }[]): Promise<string | null> => {
      setBusy(true);
      try {
        setView(await apiPost<ChatView>(`${base}/plans/${encodeURIComponent(planId)}/edit`, { items }));
        return null;
      } catch (error) {
        if (error instanceof ApiClientError && error.code === "not_joined") {
          handleFailure(error);
          return null;
        }
        await refresh();
        return error instanceof ApiClientError ? error.message : SOMETHING_WENT_WRONG;
      } finally {
        setBusy(false);
      }
    },
    [base, handleFailure, refresh],
  );

  const applyFrame = useCallback((frame: ChatStreamFrame, guestText: string) => {
    switch (frame.type) {
      case "text":
        setTurn((current) => current && { ...current, reply: current.reply + frame.text });
        break;
      case "reset":
        setTurn((current) => current && { ...current, reply: "" });
        break;
      case "done": {
        const { unsaved } = frame;
        setView(frame.view);
        setLocalLines((lines) => (unsaved ? [...lines, unsaved] : []));
        setTurn(null);
        break;
      }
      case "error":
        setLocalLines((lines) => [...lines, { guestText, reply: frame.message }]);
        setTurn(null);
        break;
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const guestText = text.trim();
      if (!guestText || turn !== null) return;
      setDraft("");
      setGuestTalked(true);
      setTurn({ guestText, reply: "" });
      try {
        await postChatMessage(`${base}/messages`, { text: guestText, lotNumber: contextLot }, (frame) => applyFrame(frame, guestText));
      } catch (error) {
        const reachedServer = error instanceof ApiClientError && error.status !== 0;
        // When the answer was lost on the way, the turn may still finish: the next read shows it.
        if (reachedServer) handleFailure(error, guestText);
        else setLocalLines((lines) => [...lines, { guestText, reply: ERROR_LINE }]);
      } finally {
        setTurn(null);
      }
    },
    [applyFrame, base, contextLot, handleFailure, turn],
  );

  function minimize() {
    setGlimPanelOpen(false);
  }

  function close() {
    setGlimPanelOpen(false);
    setDraft("");
    setContextLot(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(draft);
  }

  // 10's "Edit plan" opens the running plan's card as soon as the view has it.
  if (editRunningPlan && view) {
    const running = view.messages.findLast(
      (message) => message.card?.type === "plan" && (message.card.state === "running" || message.card.state === "paused") && message.card.edit !== null,
    );
    setEditRunningPlan(false);
    if (running?.card?.type === "plan") setEditingPlanId(running.card.planId);
  }

  const cardActions: PlanCardActions = {
    onStart: (planId) => void act(`/plans/${planId}/confirm`),
    onEditDone: editPlan,
  };
  const cardProps: ChatCardProps = {
    busy,
    actions: cardActions,
    // 09 comes back to this page once the hold is approved; other pages need no way back.
    andBack: (href) => (/\/power(?:\?|$)/.test(href) ? `${href}${href.includes("?") ? "&" : "?"}next=${encodeURIComponent(pathname)}` : href),
    slug,
    pathname,
    editingPlanId,
    setEditingPlanId,
    onSkip: (lotNumber) => void act(`/lots/${lotNumber}/skip`),
    onDismissRaise: (actionId) => void act(`/raises/${encodeURIComponent(actionId)}/dismiss`),
  };

  if (!visible) return null;


  return (
    <div
      ref={sheet}
      role="dialog"
      aria-label="Chat with Glim, your bidding agent"
      onKeyDown={(event) => {
        if (event.key === "Escape") minimize();
      }}
      className={cn(
        "fixed right-32 bottom-112 z-50 flex h-704 max-h-[calc(100dvh-128px)] w-400 max-w-[calc(100vw-64px)] flex-col overflow-hidden rounded-26 bg-panel shadow-[0_34px_80px_rgba(11,11,12,.24),0_0_0_1px_rgba(11,11,12,.06)]",
        // Below 1440 the card stops 16px under the nav (68px from 1024, 119 on a tablet), so a laptop
        // screen under 900 tall keeps bidding power and the paddle pill in view above it.
        "max-desk:max-h-[calc(100dvh-196px)] max-lg:max-h-[calc(100dvh-247px)]",
        // A short window from 768 to 1439 (a phone turned sideways): the card runs down over the orb, which
        // it covers anyway; from 1024 it still stops under the nav.
        "md:max-desk:[@media(max-height:599px)]:bottom-16 md:max-desk:[@media(max-height:599px)]:max-h-[calc(100dvh-32px)] lg:max-desk:[@media(max-height:599px)]:max-h-[calc(100dvh-100px)]",
        // Phones: a full-screen sheet over the page, as tall as what is visible (the keyboard included).
        "max-md:inset-x-0 max-md:top-[var(--glim-sheet-top,0px)] max-md:bottom-auto max-md:h-[var(--glim-sheet-height,100dvh)] max-md:max-h-none max-md:w-auto max-md:max-w-none max-md:rounded-none max-md:shadow-none",
      )}
    >
      <header className="flex h-68 flex-none items-center gap-12 border-b border-line bg-white pr-14 pl-16 max-md:h-[calc(68px+env(safe-area-inset-top))] max-md:pt-[env(safe-area-inset-top)] max-md:pr-6">
        {/* Below 375 the header needs the orb's room for the status line and Resume. */}
        <Orb size={38} className="max-[375px]:hidden" />
        <div className="min-w-0">
          <b className="block text-15 font-semibold">Glim</b>
          {view ? <StatusLine status={view.status} /> : <span className="mt-1 block text-12"> </span>}
        </div>
        <div className="ml-auto flex flex-none items-center gap-4 max-md:gap-0">
          {view?.planControl === "pause" && (
            <button
              type="button"
              aria-label="Pause Glim"
              disabled={busy}
              onClick={() => void act("/pause")}
              className="flex size-34 cursor-pointer items-center justify-center rounded-[10px] disabled:cursor-default disabled:opacity-60 max-md:size-44"
            >
              <PauseMark size={18} />
            </button>
          )}
          {view?.planControl === "resume" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("/resume")}
              className="inline-flex h-36 cursor-pointer items-center gap-6 rounded-18 bg-ink pr-14 pl-11 text-13.5 font-semibold whitespace-nowrap text-white disabled:cursor-default disabled:opacity-60 max-md:mr-2 max-md:h-40 max-md:rounded-20"
            >
              <PlayMark />
              Resume
            </button>
          )}
          <HeaderButton label="Minimize" onClick={minimize}>
            <path d="M6 12h12" />
          </HeaderButton>
          <HeaderButton label="Close" onClick={close}>
            <path d="M6 6l12 12M18 6L6 18" />
          </HeaderButton>
        </div>
      </header>

      {turn === null && !busy && <GlimLiveUpdates refresh={refresh} watchedLotIds={watchedLotIds} />}

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto p-16 [scrollbar-width:none] max-md:overscroll-contain"
      >
        {view && <GlimBubble>{view.greeting}</GlimBubble>}
        {view?.greetingCard && <ChatCard card={view.greetingCard} {...cardProps} />}
        {!view && readFailed && <GlimBubble>{ERROR_LINE}</GlimBubble>}
        {view?.messages.map((message) => (
          <ChatMessage key={message.id} message={message} {...cardProps} />
        ))}
        {localLines.map((line, index) => (
          <LocalMessage key={index} line={line} />
        ))}
        {turn && (
          <>
            <GuestBubble>{turn.guestText}</GuestBubble>
            {turn.reply ? <GlimBubble>{turn.reply}</GlimBubble> : <TypingBubble />}
          </>
        )}
        {view?.closing && <ClosingCard card={view.closing} onOpen={minimize} />}
      </div>

      {view && turn === null && view.quickReplies.length > 0 && (
        // On a phone the chips scroll sideways in their own row rather than wrap.
        <div className="flex flex-none gap-6 px-16 pb-10 max-md:overflow-x-auto max-md:overscroll-x-contain max-md:[scrollbar-width:none]">
          {view.quickReplies.map((reply) => (
            <QuickReplyChip
              key={reply.label}
              reply={reply}
              disabled={busy}
              andBack={cardProps.andBack}
              onAsk={(text) => void send(text)}
              onSkip={(lotNumber) => void act(`/lots/${lotNumber}/skip`)}
              onResume={() => void act("/resume")}
              onLeave={minimize}
            />
          ))}
        </div>
      )}

      {view?.inputClosed ? (
        <div className="mx-12 mb-12 flex h-52 flex-none items-center rounded-26 border border-line px-18 max-md:mb-[calc(12px+env(safe-area-inset-bottom))]">
          <span className="text-14 text-[#8B8B90]">{view.inputClosed}</span>
        </div>
      ) : (
        <form
          onSubmit={submit}
          className="mx-12 mb-12 flex h-52 flex-none items-center gap-10 rounded-26 border border-line bg-white pr-6 pl-18 max-md:mb-[calc(12px+env(safe-area-inset-bottom))]"
        >
          <input
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Message Glim"
            placeholder="Message Glim…"
            autoComplete="off"
            maxLength={1000}
            className="min-w-0 flex-1 bg-transparent text-14 outline-none placeholder:text-[#8B8B90] max-md:self-stretch max-md:text-16"
          />
          <button
            type="submit"
            aria-label="Send"
            disabled={turn !== null}
            className="flex size-40 flex-none cursor-pointer items-center justify-center rounded-20 bg-ink text-lime disabled:cursor-default disabled:bg-closed disabled:text-muted"
          >
            <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 19V5" />
              <path d="M6 11l6-6 6 6" />
            </svg>
          </button>
        </form>
      )}
    </div>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex size-34 cursor-pointer items-center justify-center rounded-[10px] text-ink2 max-md:size-44"
    >
      <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

/** design/22 #23: a lime dot while Glim can bid, a grey one when it can't, the pause mark, or the spinner. */
function StatusLine({ status }: { status: ChatView["status"] }) {
  const quiet = status.mark === "paused" || status.mark === "deciding";
  return (
    <span
      className={cn(
        "mt-1 flex items-center gap-6 text-12 whitespace-nowrap",
        // On a phone the header is narrower than the 400px panel, so the line takes two rows rather than an ellipsis.
        "max-md:items-start max-md:whitespace-normal max-md:[&>i]:mt-4 max-md:[&>svg]:mt-3",
        quiet ? "text-ink2" : "text-muted",
      )}
    >
      {status.mark === "deciding" && <SpinnerMark />}
      {status.mark === "paused" && <PauseMark size={10} />}
      {(status.mark === "on" || status.mark === "off") && (
        <i className={cn("size-7 flex-none rounded-4", status.mark === "on" ? "bg-lime shadow-[0_0_0_1.5px_var(--color-lime-edge)]" : "bg-muted")} />
      )}
      <span className="truncate max-md:line-clamp-2 max-md:whitespace-normal max-md:text-balance">{status.text}</span>
    </span>
  );
}

interface ChatCardProps {
  busy: boolean;
  actions: PlanCardActions;
  andBack(href: string): string;
  slug: string;
  pathname: string;
  editingPlanId: string | null;
  setEditingPlanId(planId: string | null): void;
  onSkip(lotNumber: number): void;
  onDismissRaise(actionId: string): void;
}

function ChatCard({ card, ...props }: ChatCardProps & { card: ChatCardView }) {
  const leave = () => setGlimPanelOpen(false);
  switch (card.type) {
    case "plan":
      return (
        <PlanCard
          card={card}
          busy={props.busy}
          actions={props.actions}
          editing={props.editingPlanId === card.planId}
          setEditing={(editing) => props.setEditingPlanId(editing ? card.planId : null)}
        />
      );
    case "event":
      return <EventCardView card={card} />;
    case "hold":
      return <HoldCard card={card} href={props.andBack(card.href)} onOpen={leave} />;
    case "set_power":
      return <SetPowerCard card={card} href={props.andBack(card.href)} onOpen={leave} />;
    case "closing":
      return <ClosingCard card={card} onOpen={leave} />;
    case "autopilot":
      return <AutopilotCardView card={card} busy={props.busy} onSkip={props.onSkip} />;
    case "autopilot_raise":
      return (
        <AutopilotRaiseCardView card={card} slug={props.slug} returnHref={props.pathname} busy={props.busy} onDismiss={props.onDismissRaise} />
      );
  }
}

function ChatMessage({ message, ...props }: ChatCardProps & { message: ChatMessageView }) {
  if (message.role === "guest") return <GuestBubble>{message.text}</GuestBubble>;
  return (
    <>
      {message.text && <GlimBubble>{message.text}</GlimBubble>}
      {message.card && <ChatCard card={message.card} {...props} />}
    </>
  );
}

function LocalMessage({ line }: { line: LocalLine }) {
  return (
    <>
      {line.guestText && <GuestBubble>{line.guestText}</GuestBubble>}
      <GlimBubble>{line.reply}</GlimBubble>
    </>
  );
}

const CHIP = cn(
  "inline-flex h-32 cursor-pointer items-center whitespace-nowrap rounded-16 border border-line bg-white px-12 text-12.5 font-medium disabled:cursor-default disabled:opacity-60",
  "max-md:h-40 max-md:flex-none max-md:rounded-20 max-md:px-14 max-md:text-13.5",
);

function QuickReplyChip(props: {
  reply: QuickReply;
  disabled: boolean;
  andBack(href: string): string;
  onAsk(text: string): void;
  onSkip(lotNumber: number): void;
  onResume(): void;
  onLeave(): void;
}) {
  const { reply, disabled } = props;
  if (reply.kind === "link") {
    return (
      <Link href={props.andBack(reply.href)} prefetch={false} onClick={props.onLeave} className={CHIP}>
        {reply.label}
      </Link>
    );
  }
  const click = () => {
    if (reply.kind === "ask") props.onAsk(reply.text);
    else if (reply.kind === "skip") props.onSkip(reply.lotNumber);
    else props.onResume();
  };
  return (
    <button type="button" disabled={disabled} onClick={click} className={CHIP}>
      {reply.label}
    </button>
  );
}
