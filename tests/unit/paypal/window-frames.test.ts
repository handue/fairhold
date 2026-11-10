import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as startGet } from "@/app/paypal/start/route";
import { PAYPAL_IN_TAB_KEY, paypalStartHref } from "@/app/paypal/window-message";
import {
  paypalWindowResponseWhenReady,
  renderPaypalWindowHtml,
  windowEyebrow,
  type PaypalWindowPage,
  type PaypalWindowWaiting,
} from "@/server/paypal/window-page";
import { holdFlowCopy, holdFlowReducer, type HoldFlowState } from "@/ui/power/hold-flow";
import { continueInThisTab, openBlankWindow, sendWindowToApproval, type PopupLike } from "@/ui/power/hold-window";

vi.mock("@/app/paypal/window-context", () => ({
  windowContextForEvent: vi.fn(async () => null),
  windowContextForHold: vi.fn(async () => null),
}));

const approved: PaypalWindowPage = {
  status: 200,
  outcome: "approved",
  holdId: "hold-1",
  heading: "Approved",
  detail: "$500 is held with PayPal.\nYou can close this window.",
  backHref: "/e/riverside",
  eyebrow: "Riverside Shelter Gala · Paddle 142",
};

const approving: PaypalWindowWaiting = {
  heading: "Approving your hold…",
  detail: "Confirming your $500 hold with PayPal.\nThis takes a few seconds.",
  eyebrow: "Riverside Shelter Gala · Paddle 142",
  icon: "lock",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("design/17's frames", () => {
  it("frame 3: Approved, its lines, the 3-second close and the foot", () => {
    const html = renderPaypalWindowHtml(approved);
    expect(html).toContain('<p class="ey">Riverside Shelter Gala · Paddle 142</p>');
    expect(html).toContain("<h1>Approved</h1>");
    expect(html).toContain('<span>$500 is held with PayPal.</span><span class="fh-close-line">You can close this window.</span>');
    expect(html).toContain("This window closes in 3 seconds.");
    expect(html).toContain("You’re only charged if you win.");
  });

  it("frame 4: Canceled, Close window, and trying again from the gala tab", () => {
    const html = renderPaypalWindowHtml({
      ...approved,
      outcome: "canceled",
      heading: "Canceled",
      detail: "Nothing was held.\nYou can close this window.",
    });
    expect(html).toContain("<h1>Canceled</h1>");
    expect(html).toContain(">Close window</button>");
    expect(html).toContain("You can try again from the gala tab.");
    // No timer closes it: only the button does.
    expect(html).not.toMatch(/setTimeout\(function \(\) \{ window\.close\(\); \}/);
  });

  it("goes back to the auction instead of closing when it is the gala tab itself (frame 5's trip)", () => {
    const html = renderPaypalWindowHtml(approved);
    expect(html).toContain(`sessionStorage.getItem(${JSON.stringify(PAYPAL_IN_TAB_KEY)}) === message.holdId`);
    expect(html).toContain("Taking you back to bid…");
  });

  it("escapes the line over the heading", () => {
    expect(renderPaypalWindowHtml({ ...approved, eyebrow: "<b>Gala</b>" })).toContain("&lt;b&gt;Gala&lt;/b&gt;");
    expect(windowEyebrow({ eventName: "Riverside Shelter Gala", paddleNumber: 142 })).toBe("Riverside Shelter Gala · Paddle 142");
    expect(windowEyebrow(null)).toBeNull();
  });
});

describe("frame 2 on the return page", () => {
  it("answers with the outcome and its own status when PayPal answers quickly", async () => {
    const response = await paypalWindowResponseWhenReady(Promise.resolve({ ...approved, status: 409, outcome: "refused" }), approving);
    expect(response.status).toBe(409);
    const html = await response.text();
    expect(html).not.toContain("Approving your hold…");
  });

  it("sends Approving your hold… first when PayPal is slow, then the outcome in the same response", async () => {
    let finish: (page: PaypalWindowPage) => void = () => {};
    const work = new Promise<PaypalWindowPage>((resolve) => {
      finish = resolve;
    });
    const response = await paypalWindowResponseWhenReady(work, approving, { quickMs: 5 });
    expect(response.status).toBe(200);

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('id="fh-waiting"');
    expect(first).toContain("<h1>Approving your hold…</h1>");
    expect(first).toContain("<span>Confirming your $500 hold with PayPal.</span><span>This takes a few seconds.</span>");
    expect(first).not.toContain("<script>");

    finish(approved);
    let rest = "";
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) rest += decoder.decode(chunk.value);
    expect(rest).toContain("#fh-waiting{display:none}");
    expect(rest).toContain("<h1>Approved</h1>");
    expect(rest).toContain('"outcome":"approved"');
    expect(rest.match(/<\/script>/g)).toHaveLength(1);
    expect(rest.trim().endsWith("</html>")).toBe(true);
  });
});

describe("frame 1, /paypal/start", () => {
  it("says what the guest will approve there", async () => {
    const response = await startGet(new Request("https://fairhold.example/paypal/start?e=riverside&amount=50000"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain("<h1>Opening PayPal…</h1>");
    expect(html).toContain("<span>PayPal’s page is loading.</span><span>You’ll approve a $500 hold there.</span>");
    expect(html).toContain("It’s a hold with PayPal, not a charge.");
    expect(html).not.toContain("<script>");
  });

  it("takes only a plain amount from the URL", async () => {
    for (const amount of ["", "-5", "5e3", "99999999", "<b>"]) {
      const html = await (await startGet(new Request(`https://fairhold.example/paypal/start?e=riverside&amount=${encodeURIComponent(amount)}`))).text();
      expect(html).toContain("You’ll approve the hold there.");
    }
  });

  it("is where 09 opens the window", () => {
    expect(paypalStartHref("gala-abc", 50_000)).toBe("/paypal/start?e=gala-abc&amount=50000");
  });
});

function fakePopup(overrides: Partial<PopupLike> = {}): PopupLike {
  return { closed: false, location: { replace: vi.fn() }, focus: vi.fn(), close: vi.fn(), ...overrides };
}

describe("frame 5: a blocked window waits for Continue to PayPal in this tab", () => {
  it("opens the window on frame 1", () => {
    const popup = fakePopup();
    const open = vi.fn(() => popup);
    expect(openBlankWindow({ open, location: { assign: vi.fn() } }, "/paypal/start?e=x&amount=1")).toBe(popup);
    expect(open).toHaveBeenCalledWith("/paypal/start?e=x&amount=1", "fairhold-paypal", expect.stringContaining("popup"));
  });

  it("reports a blocked or vanished window instead of sending this tab away", () => {
    const popup = fakePopup();
    expect(sendWindowToApproval(popup, "https://paypal.example/a")).toBe("popup");
    expect(popup.location.replace).toHaveBeenCalledWith("https://paypal.example/a");
    expect(sendWindowToApproval(null, "https://paypal.example/a")).toBe("blocked");
    expect(sendWindowToApproval(fakePopup({ closed: true }), "https://paypal.example/a")).toBe("blocked");
  });

  it("marks this tab, then goes to PayPal in it", () => {
    const setItem = vi.fn();
    const assign = vi.fn();
    continueInThisTab({ holdId: "hold-1", approvalUrl: "https://paypal.example/a" }, { location: { assign }, sessionStorage: { setItem } });
    expect(setItem).toHaveBeenCalledWith(PAYPAL_IN_TAB_KEY, "hold-1");
    expect(assign).toHaveBeenCalledWith("https://paypal.example/a");
  });

  it("draws the button and line of frame 5 for the blocked hold's amount, and starts over for another", () => {
    const opening: HoldFlowState = { phase: "opening", amountCents: 500_00 };
    const blocked = holdFlowReducer(opening, { type: "created", holdId: "hold-1", approvalUrl: "https://paypal.example/a", route: "blocked" });
    expect(blocked).toEqual({ phase: "blocked", amountCents: 500_00, holdId: "hold-1", approvalUrl: "https://paypal.example/a" });

    const copy = holdFlowCopy(blocked, 500_00);
    expect(copy).toMatchObject({
      button: "Continue to PayPal in this tab",
      buttonEnabled: true,
      trust: "Your browser blocked the PayPal window. You’ll come back here to bid.",
      buttonIcon: "arrow",
      trustIcon: "window",
    });
    expect(holdFlowCopy(blocked, 250_00).button).toBe("Hold $250 with PayPal");
    expect(holdFlowReducer(blocked, { type: "reset" })).toEqual({ phase: "idle" });
  });
});
