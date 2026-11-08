"use client";

import { useId, useState, type FormEvent } from "react";

import { ApiClientError, apiPost } from "../api";
import { Button } from "../Button";

interface FirstNameFormProps {
  /** POST target; it answers { href } and sets the session cookie. */
  endpoint: string;
  submitLabel: string;
  /** Sends the browser's time zone along, for a new demo's clock times. */
  sendTimeZone?: boolean;
  /** Where to go after, instead of the answer's href. */
  next?: string;
}

/**
 * The minimum that lets someone in: a first name and one button. It stands in for the approved
 * home and join designs (design/16, design/16b) until they land.
 */
export function FirstNameForm({ endpoint, submitLabel, sendTimeZone = false, next }: FirstNameFormProps) {
  const inputId = useId();
  const [firstName, setFirstName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const timeZone = sendTimeZone ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
      const { href } = await apiPost<{ href: string }>(endpoint, { firstName, timeZone });
      // A full load, so every server component reads the new session.
      window.location.assign(next ?? href);
    } catch (failure) {
      setError(failure instanceof ApiClientError ? failure.message : "Something went wrong. Please try again.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-24 flex max-w-468 flex-col gap-12">
      <label htmlFor={inputId} className="text-14 font-medium">
        First name
      </label>
      <input
        id={inputId}
        value={firstName}
        onChange={(event) => setFirstName(event.target.value)}
        autoComplete="given-name"
        maxLength={40}
        required
        className="h-48 rounded-12 border border-line px-14 text-15"
      />
      <Button type="submit" variant="lime" size={56} fullWidth disabled={pending} className="justify-center">
        {submitLabel}
      </Button>
      {error && (
        <p role="alert" className="text-14 text-ink2">
          {error}
        </p>
      )}
    </form>
  );
}
