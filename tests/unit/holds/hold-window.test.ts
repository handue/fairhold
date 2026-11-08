import { describe, expect, it, vi } from "vitest";

import { PAYPAL_WINDOW_CHANNEL, PAYPAL_WINDOW_MESSAGE_TYPE, type PaypalWindowMessage } from "@/app/paypal/window-message";
import {
  closeWindow,
  goToApproval,
  listenForPaypalWindow,
  openBlankWindow,
  PAYPAL_WINDOW_NAME,
  type ListenerHost,
  type OpenerLike,
  type PopupLike,
} from "@/ui/power/hold-window";

function fakePopup(overrides: Partial<PopupLike> = {}) {
  const body = { textContent: null as string | null };
  return {
    closed: false,
    location: { replace: vi.fn() },
    document: { body },
    focus: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

function fakeOpener(open: OpenerLike["open"] = () => null) {
  return { open: vi.fn(open), location: { assign: vi.fn() } };
}

const APPROVAL = "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1";

describe("openBlankWindow", () => {
  it("asks for a blank, named popup and says what it is waiting for", () => {
    const popup = fakePopup();
    const opener = fakeOpener(() => popup);

    expect(openBlankWindow(opener)).toBe(popup);

    const [url, target, features] = opener.open.mock.calls[0] ?? [];
    expect(url).toBe("");
    expect(target).toBe(PAYPAL_WINDOW_NAME);
    expect(features).toContain("popup");
    expect(popup.document?.body?.textContent).toBe("Opening PayPal…");
  });

  it("reads a blocked popup as null, however the browser says it", () => {
    expect(openBlankWindow(fakeOpener(() => null))).toBeNull();
    expect(openBlankWindow(fakeOpener(() => fakePopup({ closed: true })))).toBeNull();
    expect(
      openBlankWindow(
        fakeOpener(() => {
          throw new Error("blocked");
        }),
      ),
    ).toBeNull();
  });

  it("keeps a window whose blank page it cannot write to", () => {
    const popup = fakePopup();
    Object.defineProperty(popup, "document", {
      get() {
        throw new Error("no access");
      },
    });
    expect(openBlankWindow(fakeOpener(() => popup))).toBe(popup);
  });
});

describe("goToApproval", () => {
  it("points the open window at PayPal and leaves this tab where it is", () => {
    const popup = fakePopup();
    const opener = fakeOpener();

    expect(goToApproval(popup, APPROVAL, opener)).toBe("popup");

    expect(popup.location.replace).toHaveBeenCalledWith(APPROVAL);
    expect(popup.focus).toHaveBeenCalled();
    expect(opener.location.assign).not.toHaveBeenCalled();
  });

  it("redirects this tab when the popup was blocked", () => {
    const opener = fakeOpener();
    expect(goToApproval(null, APPROVAL, opener)).toBe("redirect");
    expect(opener.location.assign).toHaveBeenCalledWith(APPROVAL);
  });

  it("redirects this tab when the window closed while the server answered", () => {
    const popup = fakePopup({ closed: true });
    const opener = fakeOpener();

    expect(goToApproval(popup, APPROVAL, opener)).toBe("redirect");

    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(opener.location.assign).toHaveBeenCalledWith(APPROVAL);
  });

  it("redirects this tab when the window can no longer be steered", () => {
    const popup = fakePopup({
      location: {
        replace: () => {
          throw new Error("cross-origin");
        },
      },
    });
    const opener = fakeOpener();
    expect(goToApproval(popup, APPROVAL, opener)).toBe("redirect");
    expect(opener.location.assign).toHaveBeenCalledWith(APPROVAL);
  });
});

describe("closeWindow", () => {
  it("closes an open window and ignores the rest", () => {
    const popup = fakePopup();
    closeWindow(popup);
    expect(popup.close).toHaveBeenCalledTimes(1);

    const closed = fakePopup({ closed: true });
    closeWindow(closed);
    expect(closed.close).not.toHaveBeenCalled();

    expect(() => closeWindow(null)).not.toThrow();
    const refuses = fakePopup({
      close: () => {
        throw new Error("nope");
      },
    });
    expect(() => closeWindow(refuses)).not.toThrow();
  });
});

describe("listenForPaypalWindow", () => {
  const message: PaypalWindowMessage = { type: PAYPAL_WINDOW_MESSAGE_TYPE, outcome: "approved", holdId: "hold-1" };

  function fakeHost() {
    const listeners = new Set<(event: { origin: string; data: unknown }) => void>();
    const channels = new Map<string, (data: unknown) => void>();
    const stopChannel = vi.fn();
    const host: ListenerHost = {
      location: { origin: "https://fairhold.example" },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      listenToChannel: (name, onData) => {
        channels.set(name, onData);
        return stopChannel;
      },
    };
    return {
      host,
      listeners,
      stopChannel,
      post: (event: { origin: string; data: unknown }) => listeners.forEach((listener) => listener(event)),
      broadcast: (data: unknown) => channels.get(PAYPAL_WINDOW_CHANNEL)?.(data),
    };
  }

  it("hears the channel and same-origin postMessage", () => {
    const { host, post, broadcast } = fakeHost();
    const heard = vi.fn();
    listenForPaypalWindow(host, heard);

    broadcast(message);
    post({ origin: "https://fairhold.example", data: message });

    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledWith(message);
  });

  it("ignores another origin and anything that is not its message", () => {
    const { host, post, broadcast } = fakeHost();
    const heard = vi.fn();
    listenForPaypalWindow(host, heard);

    post({ origin: "https://evil.example", data: message });
    post({ origin: "https://fairhold.example", data: { type: "other" } });
    broadcast({ ...message, outcome: "stolen" });
    broadcast("approved");

    expect(heard).not.toHaveBeenCalled();
  });

  it("stops listening on both", () => {
    const { host, listeners, stopChannel } = fakeHost();
    const stop = listenForPaypalWindow(host, vi.fn());
    expect(listeners.size).toBe(1);

    stop();

    expect(listeners.size).toBe(0);
    expect(stopChannel).toHaveBeenCalledTimes(1);
  });
});
