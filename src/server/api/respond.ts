/**
 * JSON in and out for route handlers, and the two wrappers every API route goes through:
 *
 *   export const POST = postRoute<RouteContext<"/api/events/[slug]/join">>(async (request, { params }) => {
 *     const { slug } = await params;
 *     const session = await requirePaddle(slug, request);
 *     const body = await readJson(request, z.object({ amountCents: z.number().int().positive() }));
 *     return jsonOk({ ... });
 *   });
 *
 * Throw an ApiError anywhere inside for a typed answer; anything else is logged and answers a 500
 * that says nothing about the cause. Every answer is no-store.
 */
import { unstable_rethrow } from "next/navigation";
import type { z } from "zod";

import { getPool } from "@/server/db/client";

import { ApiError } from "./errors";
import { assertSameOrigin } from "./origin";

const NO_STORE = "no-store";

/** Enough for every JSON body the API takes; a route with a longer one passes its own limit. */
export const DEFAULT_MAX_BODY_BYTES = 16 * 1_024;

export function jsonOk<T>(data: T, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(data, { status: init.status ?? 200, headers: { "cache-control": NO_STORE, ...init.headers } });
}

export function jsonError(error: ApiError): Response {
  return Response.json(error.toBody(), {
    status: error.status,
    headers: { "cache-control": NO_STORE, ...error.headers },
  });
}

export type RouteHandler<Context> = (request: Request, context: Context) => Response | Promise<Response>;

/** Any API route: ApiErrors become the envelope, and nothing else about a failure leaves the server. */
export function apiRoute<Context = unknown>(handler: RouteHandler<Context>): RouteHandler<Context> {
  return async (request, context) => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ApiError) return jsonError(error);
      // Next's own control flow (redirect, notFound, a dynamic bailout at build time) is not a failure.
      unstable_rethrow(error);
      // The request's fault, whichever route it reached, so it never fills error_log.
      if (isInvalidText(error)) return jsonError(new ApiError(400, "invalid_request", "The request was not valid."));
      await reportUnexpected(request, error);
      return jsonError(new ApiError(500, "internal_error", "Something went wrong. Please try again."));
    }
  };
}

/** A route that changes something: apiRoute plus the same-origin check. */
export function postRoute<Context = unknown>(handler: RouteHandler<Context>): RouteHandler<Context> {
  return apiRoute((request, context) => {
    assertSameOrigin(request);
    return handler(request, context);
  });
}

/**
 * The body as JSON, checked against `schema`. Answers 415 for anything but JSON, 413 past
 * `maxBytes` (a chunked body has no Content-Length to check first), and 400 for bad JSON or a body
 * the schema refuses, naming the fields but never echoing their values.
 */
export async function readJson<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
  { maxBytes = DEFAULT_MAX_BODY_BYTES }: { maxBytes?: number } = {},
): Promise<z.output<Schema>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType.trim())) {
    throw new ApiError(415, "unsupported_media_type", "Send this request as JSON.");
  }

  const text = await readText(request, maxBytes);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "The request was not valid JSON.");
  }

  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(400, "invalid_request", "The request was not valid.", {
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

async function readText(request: Request, maxBytes: number): Promise<string> {
  const tooLarge = () => new ApiError(413, "payload_too_large", "The request was too large.");
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) throw tooLarge();
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Postgres refusing text as invalid, such as a NUL, here or anywhere in the error's cause chain. */
function isInvalidText(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === "22021") return true;
  }
  return false;
}

async function reportUnexpected(request: Request, error: unknown): Promise<void> {
  // The path only: a query string can carry a PayPal token.
  const path = new URL(request.url).pathname;
  console.error(`[api] ${request.method} ${path} failed:`, error);
  // Render keeps logs for 7 days, and the demo runs unattended for longer.
  if (process.env.NODE_ENV !== "production") return;
  const message = error instanceof Error ? error.message : String(error);
  await getPool()
    .query("insert into error_log (source, code, message, detail) values ('api', 'internal_error', $1, $2::jsonb)", [
      message,
      JSON.stringify({ method: request.method, path }),
    ])
    .catch((logFailure: unknown) => console.error("[api] could not write error_log:", logFailure));
}
