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
        else input.current?.focus();
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
    if (visible) input.current?.focus();
  }, [visible]);

  // New lines stay in view: the newest message, or the reply as it streams.
  const lineCount = (view?.messages.length ?? 0) + localLines.length;
  const streamedLength = turn?.reply.length ?? -1;
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visible, lineCount, streamedLength]);

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
      role="dialog"
      aria-label="Chat with Glim, your bidding agent"
      onKeyDown={(event) => {
        if (event.key === "Escape") minimize();
      }}
      className="fixed right-32 bottom-112 z-50 flex h-704 max-h-[calc(100dvh-128px)] w-400 max-w-[calc(100vw-64px)] flex-col overflow-hidden rounded-26 bg-panel shadow-[0_34px_80px_rgba(11,11,12,.24),0_0_0_1px_rgba(11,11,12,.06)]"
    >
      <header className="flex h-68 flex-none items-center gap-12 border-b border-line bg-white pr-14 pl-16">
        <Orb size={38} />
        <div className="min-w-0">
          <b className="block text-15 font-semibold">Glim</b>
          {view ? <StatusLine status={view.status} /> : <span className="mt-1 block text-12"> </span>}
        </div>
        <div className="ml-auto flex flex-none items-center gap-4">
          {view?.planControl === "pause" && (
            <button
              type="button"
              aria-label="Pause Glim"
              disabled={busy}
              onClick={() => void act("/pause")}
              className="flex size-34 cursor-pointer items-center justify-center rounded-[10px] disabled:cursor-default disabled:opacity-60"
            >
              <PauseMark size={18} />
            </button>
          )}
          {view?.planControl === "resume" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act("/resume")}
              className="inline-flex h-36 cursor-pointer items-center gap-6 rounded-18 bg-ink pr-14 pl-11 text-13.5 font-semibold whitespace-nowrap text-white disabled:cursor-default disabled:opacity-60"
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
        className="flex min-h-0 flex-1 flex-col gap-10 overflow-y-auto p-16 [scrollbar-width:none]"
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
        <div className="flex flex-none gap-6 px-16 pb-10">
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
        <div className="mx-12 mb-12 flex h-52 flex-none items-center rounded-26 border border-line px-18">
          <span className="text-14 text-[#8B8B90]">{view.inputClosed}</span>
        </div>
      ) : (
        <form onSubmit={submit} className="mx-12 mb-12 flex h-52 flex-none items-center gap-10 rounded-26 border border-line bg-white pr-6 pl-18">
          <input
            ref={input}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            aria-label="Message Glim"
            placeholder="Message Glim…"
            autoComplete="off"
            maxLength={1000}
            className="min-w-0 flex-1 bg-transparent text-14 outline-none placeholder:text-[#8B8B90]"
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
    <button type="button" aria-label={label} onClick={onClick} className="flex size-34 cursor-pointer items-center justify-center rounded-[10px] text-ink2">
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
    <span className={cn("mt-1 flex items-center gap-6 text-12 whitespace-nowrap", quiet ? "text-ink2" : "text-muted")}>
      {status.mark === "deciding" && <SpinnerMark />}
      {status.mark === "paused" && <PauseMark size={10} />}
      {(status.mark === "on" || status.mark === "off") && (
        <i className={cn("size-7 flex-none rounded-4", status.mark === "on" ? "bg-lime shadow-[0_0_0_1.5px_var(--color-lime-edge)]" : "bg-muted")} />
      )}
      <span className="truncate">{status.text}</span>
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

const CHIP = "inline-flex h-32 cursor-pointer items-center whitespace-nowrap rounded-16 border border-line bg-white px-12 text-12.5 font-medium disabled:cursor-default disabled:opacity-60";

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
