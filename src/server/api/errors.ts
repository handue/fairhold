/**
 * The one error shape every API route answers with, and the exception that produces it. No server
 * imports, so the browser's fetch wrapper (src/ui/api.ts) can share the type.
 */

export interface ApiErrorBody {
  error: {
    /** Stable and machine-readable, e.g. "not_joined", "over_bidding_power". */
    code: string;
    /** One English sentence a guest can read. */
    message: string;
    /** The figures behind the error, or null. */
    details: unknown;
  };
}

/** Throw it from a route handler or anything it calls; apiRoute and postRoute turn it into the response. */
export class ApiError extends Error {
  override name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown = null,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}
