/**
 * The browser's way to call the API: JSON in and out, and every failure as one error type.
 *
 *   const { slug } = await apiPost<{ slug: string }>("/api/demo", { firstName });
 *
 *   try {
 *     await apiPost(`/api/events/${slug}/lots/7/bid`, { amountCents });
 *   } catch (error) {
 *     if (error instanceof ApiClientError && error.code === "over_bidding_power") ...
 *     // error.message is always a sentence a guest can read.
 *   }
 *
 * Code "not_joined" means the guest has no session for the event: send them to joinHref(slug, next).
 */
import type { ApiErrorBody } from "@/server/api/errors";

export class ApiClientError extends Error {
  override name = "ApiClientError";

  constructor(
    /** The HTTP status; 0 when the request never got an answer. */
    readonly status: number,
    /** The server's code, or "network_error" or "invalid_response". */
    readonly code: string,
    message: string,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

const NETWORK_MESSAGE = "We couldn’t reach Fairhold. Check your connection and try again.";
const UNREADABLE_MESSAGE = "Something went wrong. Please try again.";

function isErrorBody(value: unknown): value is ApiErrorBody {
  const error = (value as Partial<ApiErrorBody> | null)?.error;
  return typeof error?.code === "string" && typeof error.message === "string";
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...init.headers },
    });
  } catch (error) {
    // The caller's own abort is not a failure to report.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiClientError(0, "network_error", NETWORK_MESSAGE);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) throw new ApiClientError(response.status, "invalid_response", UNREADABLE_MESSAGE);
  }
  if (response.ok) return body as T;
  if (isErrorBody(body)) {
    throw new ApiClientError(response.status, body.error.code, body.error.message, body.error.details ?? null);
  }
  throw new ApiClientError(response.status, "invalid_response", UNREADABLE_MESSAGE);
}

export function apiGet<T>(path: string, init: Pick<RequestInit, "signal"> = {}): Promise<T> {
  return apiFetch<T>(path, { ...init, method: "GET" });
}

export function apiPost<T>(path: string, body: unknown = {}, init: Pick<RequestInit, "signal"> = {}): Promise<T> {
  return apiFetch<T>(path, {
    ...init,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
