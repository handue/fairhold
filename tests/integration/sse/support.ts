/** Reading /api/stream the way a browser does: frames off the response body, as they arrive. */
import type pg from "pg";

import { GET } from "@/app/api/stream/route";
import { createSession, sessionCookieName } from "@/server/api";
import type { StreamControlPayloads, StreamEvent } from "@/server/sse/types";

export interface Frame {
  id: string | null;
  event: string;
  data: unknown;
}

export const isRow = (frame: Frame): boolean => frame.id !== null;
export const rowOf = (frame: Frame) => frame.data as StreamEvent;

function parseFrame(block: string): Frame | null {
  let id: string | null = null;
  let event = "message";
  let data: string | null = null;
  for (const line of block.split("\n")) {
    if (line.startsWith("id: ")) id = line.slice(4);
    else if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("data: ")) data = line.slice(6);
  }
  return data === null ? null : { id, event, data: JSON.parse(data) };
}

export class StreamReader {
  readonly frames: Frame[] = [];
  ended = false;
  private waiters: (() => void)[] = [];
  private readonly finished: Promise<void>;

  constructor(
    readonly response: Response,
    private readonly controller: AbortController,
  ) {
    this.finished = this.read();
  }

  private async read(): Promise<void> {
    if (!this.response.body) throw new Error("The response has no body");
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const frame = parseFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (frame) this.frames.push(frame);
        }
        this.notify();
      }
    } catch {
      // The test aborted it.
    }
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) waiter();
  }

  /** The frames that are event_log rows, in the order they came. */
  get rows(): StreamEvent[] {
    return this.frames.filter(isRow).map(rowOf);
  }

  get hello(): StreamControlPayloads["hello"] {
    const frame = this.frames.find((candidate) => candidate.event === "hello");
    if (!frame) throw new Error("No hello yet");
    return frame.data as StreamControlPayloads["hello"];
  }

  /** Resolves with the first frame that matches, waiting for it to arrive. */
  async waitFor(matches: (frame: Frame) => boolean, timeoutMs = 3_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.frames.find(matches);
      if (found) return found;
      if (this.ended) throw new Error(`The stream ended without it. Got: ${JSON.stringify(this.frames)}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timed out. Got: ${JSON.stringify(this.frames)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Waits until the stream is live: rows committed after this reach it through fan-out. */
  async ready(): Promise<this> {
    await this.waitFor((frame) => frame.event === "hello");
    // The replay and the move to live follow within the same few reads.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return this;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.finished;
  }

  async untilEnded(timeoutMs = 3_000): Promise<void> {
    await this.waitFor(() => false, timeoutMs).catch(() => {});
    if (!this.ended) throw new Error("The stream did not end");
  }
}

export interface OpenStream {
  slug: string;
  cookie?: string;
  after?: string;
  lastEventId?: string;
  paddle?: number;
}

export async function openStream({ slug, cookie, after, lastEventId, paddle }: OpenStream): Promise<StreamReader> {
  const url = new URL("https://fairhold.example/api/stream");
  url.searchParams.set("slug", slug);
  if (after !== undefined) url.searchParams.set("after", after);
  if (paddle !== undefined) url.searchParams.set("paddle", String(paddle));
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  if (lastEventId) headers.set("last-event-id", lastEventId);
  const controller = new AbortController();
  const response = await GET(new Request(url, { headers, signal: controller.signal }), undefined);
  return new StreamReader(response, controller);
}

/** A browser's session cookie for a paddle or an organizer of this event. */
export async function sessionCookie(
  pool: pg.Pool,
  slug: string,
  input: { eventId: string; paddleId: string | null; isOrganizer?: boolean },
): Promise<string> {
  const created = await createSession(input, pool);
  return `${sessionCookieName(slug)}=${created.token}`;
}

export async function slugOf(pool: pg.Pool, eventId: string): Promise<string> {
  const { rows } = await pool.query<{ slug: string }>("select slug from events where id = $1", [eventId]);
  const slug = rows[0]?.slug;
  if (!slug) throw new Error("no such event");
  return slug;
}

/** Waits until `check` holds, for what has no frame to wait on. */
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
