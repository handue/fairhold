import { describe, expect, it } from "vitest";

import { isPaypalWindowMessage, PAYPAL_WINDOW_CHANNEL } from "@/app/paypal/window-message";
import { backHrefFor, paypalWindowResponse, renderPaypalWindowHtml, type PaypalWindowPage } from "@/server/paypal/window-page";

const approved: PaypalWindowPage = {
  status: 200,
  outcome: "approved",
  holdId: "hold-1",
  heading: "Bidding power is set",
  detail: "$500 is on hold with PayPal.",
  backHref: "/e/riverside",
};

function inlineScript(html: string): string {
  const match = /<script>([\s\S]*)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("no inline script");
  return match[1];
}

describe("PayPal window page", () => {
  it("tells the opener on a BroadcastChannel and with postMessage to this origin", () => {
    const script = inlineScript(renderPaypalWindowHtml(approved));

    expect(script).toContain(`new BroadcastChannel(${JSON.stringify(PAYPAL_WINDOW_CHANNEL)})`);
    expect(script).toContain("window.opener.postMessage(message, window.location.origin)");
    const message = JSON.parse(/var message = (\{.*?\});/.exec(script)?.[1] ?? "null");
    expect(isPaypalWindowMessage(message)).toBe(true);
    expect(message).toEqual({ type: "fairhold:paypal-hold", outcome: "approved", holdId: "hold-1" });
  });

  it("closes as a popup or returns to the auction, except on a page the guest must read", () => {
    expect(inlineScript(renderPaypalWindowHtml(approved))).toContain("window.close()");
    expect(inlineScript(renderPaypalWindowHtml(approved))).toContain('window.location.replace("/e/riverside")');
    for (const outcome of ["error", "refused"] as const) {
      const script = inlineScript(renderPaypalWindowHtml({ ...approved, outcome }));
      expect(script).not.toContain("window.close()");
      expect(script).not.toContain("window.location.replace");
    }
  });

  it("escapes text and keeps the inline script closed to injected markup", () => {
    const html = renderPaypalWindowHtml({
      ...approved,
      holdId: "</script><script>alert(1)</script>",
      heading: "<b>Bold</b> & co",
    });

    expect(html).toContain("&lt;b&gt;Bold&lt;/b&gt; &amp; co");
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("is never cached and keeps PayPal's token out of the referrer", async () => {
    const response = paypalWindowResponse(approved);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    await expect(response.text()).resolves.toContain("<h1>Bidding power is set</h1>");
  });
});

describe("backHrefFor", () => {
  it("keeps a same-origin path", () => {
    expect(backHrefFor("/e/riverside/lots/7?from=power#bid", "riverside")).toBe("/e/riverside/lots/7?from=power#bid");
  });

  it.each(["//evil.example", "/\t/evil.example", "/\\evil.example", "https://evil.example/", "javascript:alert(1)", ""])(
    "falls back to the event page for %j",
    (next) => {
      expect(backHrefFor(next, "riverside")).toBe("/e/riverside");
    },
  );

  it("checks the path a browser resolves, not the one written", () => {
    expect(backHrefFor("/e/riverside/./lots/%37", "riverside")).toBe("/e/riverside/lots/%37");
    expect(backHrefFor("/e/riverside/../../%2e%2e//evil.example", "riverside")).toBe("/e/riverside");
    expect(backHrefFor("/e/riverside/..//evil.example", "riverside")).toBe("/e/riverside");
  });

  it("only returns to pages of the hold's own event", () => {
    expect(backHrefFor("/e/other-gala/lots/7", "riverside")).toBe("/e/riverside");
    expect(backHrefFor("/e/riversidex", "riverside")).toBe("/e/riverside");
    expect(backHrefFor("/paypal/cancel?hold=x", "riverside")).toBe("/e/riverside");
    expect(backHrefFor("/e/riverside", "riverside")).toBe("/e/riverside");
  });

  it("falls back to the home page without an event, whatever next says", () => {
    expect(backHrefFor(null, null)).toBe("/");
    expect(backHrefFor("/e/riverside/lots/7", null)).toBe("/");
  });
});
