/** The message route's NDJSON answer, and the browser's end of it. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_STREAM_HEADERS, chatStreamResponse } from "@/server/chat/stream";
import type { ChatStreamFrame } from "@/server/chat/types";
import { ApiClientError } from "@/ui/api";
import { postChatMessage, readChatFrames } from "@/ui/glim/frames";

vi.mock("@/server/db/client", () => ({ getPool: () => ({ query: vi.fn(async () => ({ rows: [] })) }) }));

async function framesOf(response: Response): Promise<ChatStreamFrame[]> {
  const frames: ChatStreamFrame[] = [];
  if (response.body) await readChatFrames(response.body, (frame) => frames.push(frame));
  return frames;
}

describe("chatStreamResponse", () => {
  it("sends each frame on its own line, with the headers that stop buffering", async () => {
    const response = chatStreamResponse(async (send) => {
      send({ type: "text", text: "Hello " });
      send({ type: "reset" });
      send({ type: "text", text: "there" });
    });
    expect(Object.fromEntries(response.headers)).toMatchObject(CHAT_STREAM_HEADERS);
    expect(CHAT_STREAM_HEADERS["cache-control"]).toContain("no-transform");
    expect(await response.text()).toBe('{"type":"text","text":"Hello "}\n{"type":"reset"}\n{"type":"text","text":"there"}\n');
  });

  it("delivers a frame before the turn ends", async () => {
    let finish = () => {};
    const response = chatStreamResponse(async (send) => {
      send({ type: "text", text: "first" });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      send({ type: "text", text: "second" });
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe('{"type":"text","text":"first"}\n');
    finish();
    await reader?.cancel();
  });

  it("ends a failed turn with an error frame that says nothing about the cause", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = chatStreamResponse(async () => {
      throw new Error("the secret cause");
    });
    expect(await framesOf(response)).toEqual([{ type: "error", code: "internal_error", message: "Something went wrong. Please try again." }]);
    quiet.mockRestore();
  });

  it("keeps the turn going after the browser leaves", async () => {
    let sent = 0;
    let finished = () => {};
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let goOn = () => {};
    const response = chatStreamResponse(async (send) => {
      send({ type: "text", text: "a" });
      await new Promise<void>((resolve) => {
        goOn = resolve;
      });
      send({ type: "text", text: "b" });
      sent += 1;
      finished();
    });
    await response.body?.cancel();
    goOn();
    await done;
    expect(sent).toBe(1);
  });
});

describe("readChatFrames", () => {
  const streamOf = (...chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });

  it("waits for a line to complete across chunks", async () => {
    const frames: ChatStreamFrame[] = [];
    await readChatFrames(streamOf('{"type":"te', 'xt","text":"Hi"}\n{"type":', '"reset"}\n'), (frame) => frames.push(frame));
    expect(frames).toEqual([{ type: "text", text: "Hi" }, { type: "reset" }]);
  });

  it("reads a last line with no newline, and multi-byte text split across chunks", async () => {
    const encoded = new TextEncoder().encode('{"type":"text","text":"I’ll"}');
    const split = encoded.findIndex((byte) => byte > 127) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
        controller.close();
      },
    });
    const frames: ChatStreamFrame[] = [];
    await readChatFrames(stream, (frame) => frames.push(frame));
    expect(frames).toEqual([{ type: "text", text: "I’ll" }]);
  });
});

describe("postChatMessage", () => {
  const body = { text: "Hi", lotNumber: null };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the frames of a streamed answer, and sends what it was given as JSON", async () => {
    const fetchMock = vi.fn(async () => new Response('{"type":"text","text":"Hi"}\n', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const frames: ChatStreamFrame[] = [];
    await postChatMessage("/api/glim/gala/messages", body, (frame) => frames.push(frame));
    expect(frames).toEqual([{ type: "text", text: "Hi" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/glim/gala/messages",
      expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify(body) }),
    );
  });

  it("throws the server's refusal, as every other call does", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { code: "not_joined", message: "Join this event to continue.", details: null } }, { status: 401 }),
    );
    await expect(postChatMessage("/x", body, () => {})).rejects.toMatchObject({ status: 401, code: "not_joined", message: "Join this event to continue." });
  });

  it("reads anything else as a plain failure, with no answer as status 0", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }));
    await expect(postChatMessage("/x", body, () => {})).rejects.toMatchObject({ status: 502, code: "invalid_response" });
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const failure = await postChatMessage("/x", body, () => {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiClientError);
    expect(failure).toMatchObject({ status: 0, code: "network_error" });
  });

  it("calls a stream that breaks halfway a lost answer", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError("network"));
      },
    });
    vi.stubGlobal("fetch", async () => new Response(broken, { status: 200 }));
    await expect(postChatMessage("/x", body, () => {})).rejects.toMatchObject({ status: 0, code: "network_error" });
  });
});
