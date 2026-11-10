"use client";

import { useActionState, useEffect, useId, useMemo, useSyncExternalStore, type ReactNode } from "react";

import { AlertIcon } from "../demo/icons";
import { wrapAtSeparators } from "../format";
import { ArrowRightIcon, LockIcon } from "../icons";

import { joinEventAction, startDemoAction } from "./actions";
import { ENTRY_IDLE, HYDRATED_FIELD, type EntryFormState } from "./entry-state";

/**
 * The home and join forms. Both post to a Server Action, so a press before hydration (or with
 * scripts off) is an ordinary form post that the server answers with the session and a redirect.
 * After hydration React sends the same action itself and keeps the page while it runs.
 */

/** 09's lime button: label left, arrow right, 56px. */
function LimeSubmit({ pending, children }: { pending: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      className="flex h-56 w-full cursor-pointer items-center justify-between rounded-16 bg-lime pr-20 pl-22 text-16 font-semibold text-ink aria-disabled:cursor-progress"
    >
      {children}
      <ArrowRightIcon size={18} />
    </button>
  );
}

/** 20's help line on an error: ink2, with the circled mark. */
function FormError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={`flex items-center gap-6 text-12.5 leading-16 text-ink2 ${className ?? ""}`}>
      <AlertIcon size={14} strokeWidth={2.2} className="flex-none text-ink" />
      <span>{message}</span>
    </p>
  );
}

const noSubscription = () => () => {};

/** The browser's time zone, once hydrated; before that the gala keeps its own. */
function useTimeZone(): string {
  return useSyncExternalStore(
    noSubscription,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => "",
  );
}

/**
 * Marks the form hydrated (HYDRATED_FIELD), and loads the page the server answered with in full,
 * so the event's layout reads the new session from its first render.
 */
function Hydrated({ state }: { state: EntryFormState }) {
  const hydrated = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  useEffect(() => {
    if (state.href) window.location.assign(state.href);
  }, [state]);
  return <input type="hidden" name={HYDRATED_FIELD} value={hydrated ? "1" : ""} />;
}

/** 16 and 16c: one lime button that starts a private demo gala, and the line under it. On a phone both fill the width. */
export function StartDemoForm({ label, meta }: { label: string; meta: string }) {
  const [state, action, pending] = useActionState(startDemoAction, ENTRY_IDLE);
  const timeZone = useTimeZone();
  return (
    <form action={action} onSubmit={(event) => pending && event.preventDefault()} className="w-480 text-left max-md:w-full">
      <input type="hidden" name="timeZone" value={timeZone} />
      <Hydrated state={state} />
      <LimeSubmit pending={pending || state.href !== null}>{label}</LimeSubmit>
      <FormError message={state.error} className="mt-12" />
      {/* On a phone it wraps only after a "·", each part whole. */}
      <p className="mt-16 text-12.5 leading-18 whitespace-nowrap text-ink2 max-md:mt-12 max-md:whitespace-normal">
        {wrapAtSeparators(meta)}
      </p>
    </form>
  );
}

/** 16b: the first name, Get my paddle, and the line about what comes next. */
export function JoinForm({ slug, next }: { slug: string; next: string | null }) {
  const join = useMemo(() => joinEventAction.bind(null, { slug, next }), [slug, next]);
  const [state, action, pending] = useActionState(join, ENTRY_IDLE);
  const inputId = useId();
  return (
    <form action={action} onSubmit={(event) => pending && event.preventDefault()} className="w-480 text-left max-md:w-full">
      <Hydrated state={state} />
      <div className="mt-40 flex items-baseline justify-between">
        <label htmlFor={inputId} className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">
          First name
        </label>
        <span className="text-12.5 leading-16 text-muted">No account needed</span>
      </div>
      <input
        id={inputId}
        name="firstName"
        defaultValue={state.firstName}
        key={state.firstName}
        placeholder="Your first name"
        autoComplete="given-name"
        maxLength={40}
        required
        aria-invalid={state.error ? true : undefined}
        className="mt-8 h-56 w-full rounded-16 border border-line bg-white px-21 text-16 text-ink outline-none placeholder:text-[#8b8b90] focus-visible:border-ink"
      />
      <FormError message={state.error} className="mt-8" />
      <div className="mt-12">
        <LimeSubmit pending={pending || state.href !== null}>Get my paddle</LimeSubmit>
      </div>
      <p className="mt-16 flex items-center gap-8 text-12.5 leading-18 text-ink2 max-md:text-balance">
        <LockIcon size={15} className="flex-none" />
        Next, you’ll set your bidding power with PayPal, then bid.
      </p>
    </form>
  );
}
