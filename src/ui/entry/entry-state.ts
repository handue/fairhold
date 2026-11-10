/** What the home and join forms show after a press the server refused. Safe for client code. */
export interface EntryFormState {
  /** A sentence the guest can read, under the form. */
  error: string | null;
  /** What was typed, so a refused form keeps it. */
  firstName: string;
  /** Where a hydrated page goes next, with a full load (see the `hydrated` field). */
  href: string | null;
}

export const ENTRY_IDLE: EntryFormState = { error: null, firstName: "", href: null };

/**
 * A hidden field the forms set once hydrated. A form posted before that gets the server's redirect;
 * a hydrated one gets `href` back and loads it in full, so every part of the event's layout reads
 * the new session from the start, as the API's callers always did.
 */
export const HYDRATED_FIELD = "hydrated";

/** The name a demo gala's creator gets: the guest on every approved screen. */
export const DEMO_GUEST_NAME = "Jamie";
