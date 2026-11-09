/**
 * PayPal webhook receiver. Reads the raw body (verification needs it byte for byte), verifies it
 * with PayPal and stores the event once. Any non-2xx answer makes PayPal deliver again, up to 25
 * times over 3 days, so only a verified-and-stored or duplicate event gets a 200. Applying the event
 * to holds and settlement items starts here and does not hold up the answer; the engine tick picks
 * up whatever this leaves behind (src/server/settlement/webhook.ts).
 */
import { MAX_WEBHOOK_BODY_BYTES, receivePaypalWebhook } from "@/server/paypal/webhooks";
import { kickWebhookProcessing } from "@/server/settlement/runner";

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) return reply(413, { ok: false, error: "too_large" });

  const transmissionId = request.headers.get("paypal-transmission-id") ?? "none";
  try {
    const rawBody = await readRawBody(request, MAX_WEBHOOK_BODY_BYTES);
    if (rawBody === null) return reply(413, { ok: false, error: "too_large" });

    const outcome = await receivePaypalWebhook(rawBody, request.headers);
    switch (outcome.kind) {
      case "stored":
      case "duplicate":
        kickWebhookProcessing({ paypalEventId: outcome.eventId });
        return reply(200, { ok: true, result: outcome.kind });
      case "rejected":
        console.warn(`[paypal/webhook] rejected transmission ${transmissionId}: ${outcome.reason}`);
        return reply(outcome.reason === "too_large" ? 413 : 400, { ok: false, error: outcome.reason });
      case "unavailable":
        console.error(
          `[paypal/webhook] could not verify transmission ${transmissionId}: ${outcome.reason}`,
          outcome.error?.message ?? "",
        );
        return reply(503, { ok: false, error: outcome.reason });
    }
  } catch (error) {
    console.error(`[paypal/webhook] transmission ${transmissionId} failed:`, error);
    return reply(503, { ok: false, error: "unavailable" });
  }
}

/** The body as text, or null past `maxBytes`; a chunked body has no Content-Length to check first. */
async function readRawBody(request: Request, maxBytes: number): Promise<string | null> {
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
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}
