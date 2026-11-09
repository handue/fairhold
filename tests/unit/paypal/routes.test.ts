import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as cancelGet } from "@/app/paypal/cancel/route";
import { GET as returnGet } from "@/app/paypal/return/route";
import { POST as webhookPost } from "@/app/api/paypal/webhook/route";
import { PaypalError } from "@/server/paypal/errors";
import type { HoldRecord } from "@/server/paypal/hold-store";
import { cancelHoldApproval, completeHoldApproval } from "@/server/paypal/holds";
import { receivePaypalWebhook } from "@/server/paypal/webhooks";

vi.mock("@/server/paypal/holds", () => ({ completeHoldApproval: vi.fn(), cancelHoldApproval: vi.fn() }));
vi.mock("@/server/paypal/webhooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/paypal/webhooks")>()),
  receivePaypalWebhook: vi.fn(),
}));

const hold: HoldRecord = {
  id: "hold-1",
  eventId: "event-1",
  eventSlug: "riverside",
  paddleId: "paddle-142",
  kind: "paypal",
  status: "authorized",
  amountCents: 500_00,
  paypalOrderId: "ORDER1",
  originalAuthorizationId: "AUTH1",
  currentAuthorizationId: "AUTH1",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /paypal/return", () => {
  it("authorizes the hold named in the URL with PayPal's token and confirms it", async () => {
    vi.mocked(completeHoldApproval).mockResolvedValue({ kind: "authorized", hold, alreadyAuthorized: false });

    const response = await returnGet(
      new Request("https://fairhold.example/paypal/return?hold=hold-1&next=%2Fe%2Friverside%2Flots%2F7&token=ORDER1&PayerID=P1"),
    );

    expect(completeHoldApproval).toHaveBeenCalledWith({ holdId: "hold-1", orderId: "ORDER1" });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("$500 is on hold with PayPal");
    expect(html).toContain('"outcome":"approved"');
    expect(html).toContain('href="/e/riverside/lots/7"');
  });

  it("explains a decline without claiming anything was held", async () => {
    vi.mocked(completeHoldApproval).mockResolvedValue({
      kind: "declined",
      hold: { ...hold, status: "denied" },
      error: new PaypalError({ operation: "authorizeOrder", code: "INSTRUMENT_DECLINED" }),
    });

    const html = await (await returnGet(new Request("https://fairhold.example/paypal/return?hold=hold-1&token=ORDER1"))).text();

    expect(html).toContain("PayPal declined the hold");
    expect(html).toContain("Nothing was held");
    expect(html).toContain('"outcome":"declined"');
  });

  it("sends a declined guest back to bidding power to try again, not on to bid", async () => {
    vi.mocked(completeHoldApproval).mockResolvedValue({
      kind: "declined",
      hold: { ...hold, status: "denied" },
      error: new PaypalError({ operation: "authorizeOrder", code: "INSTRUMENT_DECLINED" }),
    });

    const html = await (
      await returnGet(new Request("https://fairhold.example/paypal/return?hold=hold-1&next=%2Fe%2Friverside%2Flots%2F7&token=ORDER1"))
    ).text();

    expect(html).toContain('href="/e/riverside/power?next=%2Fe%2Friverside%2Flots%2F7"');
  });

  it("says the bidding power stayed as it was when a stale raise is refused, and stays open", async () => {
    vi.mocked(completeHoldApproval).mockResolvedValue({
      kind: "refused",
      hold: { ...hold, id: "hold-600", status: "voided", amountCents: 600_00 },
      refusal: { reason: "not_a_raise", currentHoldCents: 750_00 },
    });

    const response = await returnGet(
      new Request("https://fairhold.example/paypal/return?hold=hold-600&next=%2Fe%2Friverside%2Fpower&token=ORDER2"),
    );

    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).toContain("Your bidding power stays at $750");
    expect(html).toContain("this $600 hold was released");
    expect(html).toContain('"outcome":"refused"');
    expect(html).not.toContain("window.close()");
    expect(html).toContain('href="/e/riverside/power"');
  });

  it("answers 400 without a hold and 500 when the approval throws", async () => {
    expect((await returnGet(new Request("https://fairhold.example/paypal/return?token=ORDER1"))).status).toBe(400);
    expect(completeHoldApproval).not.toHaveBeenCalled();

    vi.mocked(completeHoldApproval).mockRejectedValue(new Error("database down"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await returnGet(new Request("https://fairhold.example/paypal/return?hold=hold-1"));
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain('"outcome":"error"');
    // The tab that opened the window is waiting on this hold, so it has to hear which one failed.
    expect(html).toContain('"holdId":"hold-1"');
    errorLog.mockRestore();
  });
});

describe("GET /paypal/cancel", () => {
  it("cancels the pending hold and tells the opener", async () => {
    vi.mocked(cancelHoldApproval).mockResolvedValue({ kind: "canceled", hold: { ...hold, status: "canceled" } });

    const response = await cancelGet(new Request("https://fairhold.example/paypal/cancel?hold=hold-1&token=ORDER1"));

    expect(cancelHoldApproval).toHaveBeenCalledWith({ holdId: "hold-1", orderId: "ORDER1" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"outcome":"canceled"');
  });

  it("sends a canceled guest back to bidding power, keeping the way back", async () => {
    vi.mocked(cancelHoldApproval).mockResolvedValue({ kind: "canceled", hold: { ...hold, status: "canceled" } });

    const html = await (
      await cancelGet(new Request("https://fairhold.example/paypal/cancel?hold=hold-1&next=%2Fe%2Friverside%2Flots%2F7&token=ORDER1"))
    ).text();

    expect(html).toContain('href="/e/riverside/power?next=%2Fe%2Friverside%2Flots%2F7"');
  });

  it("reports an already approved hold as approved", async () => {
    vi.mocked(cancelHoldApproval).mockResolvedValue({ kind: "not_pending", hold });

    const html = await (await cancelGet(new Request("https://fairhold.example/paypal/cancel?hold=hold-1"))).text();

    expect(html).toContain('"outcome":"approved"');
  });
});

describe("POST /api/paypal/webhook", () => {
  function delivery(body: string, headers: Record<string, string> = {}) {
    return new Request("https://fairhold.example/api/paypal/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "paypal-transmission-id": "t-1", ...headers },
      body,
    });
  }

  it("hands the raw body to verification and answers 200 for stored and duplicate events", async () => {
    vi.mocked(receivePaypalWebhook).mockResolvedValue({ kind: "stored", eventId: "WH-1", eventType: "X" });
    const raw = '{"id":"WH-1",  "event_type":"X"}';

    const response = await webhookPost(delivery(raw));

    expect(response.status).toBe(200);
    expect(vi.mocked(receivePaypalWebhook).mock.calls[0]?.[0]).toBe(raw);
    vi.mocked(receivePaypalWebhook).mockResolvedValue({ kind: "duplicate", eventId: "WH-1", eventType: "X" });
    expect((await webhookPost(delivery(raw))).status).toBe(200);
  });

  it("answers 400 for a rejected delivery and 503 when PayPal should try again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.mocked(receivePaypalWebhook).mockResolvedValue({ kind: "rejected", reason: "invalid_signature" });
    expect((await webhookPost(delivery("{}"))).status).toBe(400);
    vi.mocked(receivePaypalWebhook).mockResolvedValue({ kind: "unavailable", reason: "not_configured" });
    expect((await webhookPost(delivery("{}"))).status).toBe(503);
    vi.mocked(receivePaypalWebhook).mockRejectedValue(new Error("database down"));
    expect((await webhookPost(delivery("{}"))).status).toBe(503);

    warn.mockRestore();
    errorLog.mockRestore();
  });

  it("refuses an oversized body before reading it", async () => {
    const response = await webhookPost(delivery("{}", { "content-length": String(10 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(receivePaypalWebhook).not.toHaveBeenCalled();
  });

  it("stops reading a chunked body once it passes the limit", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 100) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request("https://fairhold.example/api/paypal/webhook", { method: "POST", body, duplex: "half" } as RequestInit);

    const response = await webhookPost(request);

    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(10);
    expect(receivePaypalWebhook).not.toHaveBeenCalled();
  });
});
