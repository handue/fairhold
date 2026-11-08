/**
 * Turns a hub subscription into the Response /api/stream answers with: Server-Sent Events, one
 * frame per row (types.ts has the format).
 */
import type { StreamHub, StreamSink, StreamSubscription } from "./hub";
import type { StreamControlEvent, StreamControlPayloads, StreamEvent } from "./types";

/**
 * "no-transform" also keeps Next's compression off this response, which would hold frames back.
 * "close" is for shutdown: Next exits once every connection is gone, and a browser's retry would
 * otherwise reuse this connection every few seconds and keep it from ever going idle.
 */
const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "close",
};

/** How long the browser waits before it retries by itself after a dropped connection. */
const RETRY_MS = 3_000;

/** A client this far behind has stopped reading. It catches up by replay when it reconnects. */
const MAX_BUFFERED_BYTES = 1_024 * 1_024;
const HIGH_WATER_BYTES = 64 * 1_024;

export function encodeRowFrame(row: StreamEvent): string {
  return `id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify(row)}\n\n`;
}

/** Control frames have no id, so they never move the browser's Last-Event-ID. */
export function encodeControlFrame<Name extends StreamControlEvent>(name: Name, payload: StreamControlPayloads[Name]): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** `onClose` runs once, whichever way the stream ends. */
export function openStreamResponse(
  hub: StreamHub,
  subscription: Omit<StreamSubscription, "sink">,
  request: Request,
  onClose: () => void = () => {},
): Response {
  const encoder = new TextEncoder();
  let finish = () => {};

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let open = true;
        let unsubscribe = () => {};

        finish = () => {
          if (open) onClose();
          open = false;
          request.signal.removeEventListener("abort", end);
          unsubscribe();
        };
        // This closure holds the request and not only its signal: a Request that gets collected
        // takes with it the controller that would have aborted the signal.
        const end = () => {
          if (!open) return;
          finish();
          try {
            controller.close();
          } catch {
            // The client already went away, which cancels the stream.
          }
        };

        const write = (frame: string) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            finish();
            return;
          }
          if ((controller.desiredSize ?? 0) < -MAX_BUFFERED_BYTES) end();
        };

        const sink: StreamSink = {
          row: (row) => write(encodeRowFrame(row)),
          control: (name, payload) => write(encodeControlFrame(name, payload)),
          end,
        };

        write(`retry: ${RETRY_MS}\n\n`);
        unsubscribe = hub.subscribe({ ...subscription, sink });
        request.signal.addEventListener("abort", end, { once: true });
        if (request.signal.aborted) end();
      },
      cancel() {
        finish();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER_BYTES }),
  );

  return new Response(body, { headers: STREAM_HEADERS });
}
