import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { eventSlugFromPath } from "@/ui/event/event-path";
import { GLIM_OPEN_EVENT, onGlimOpen, openGlim, type GlimOpenDetail } from "@/ui/glim-events";

describe("opening Glim", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reaches every listener with the detail", () => {
    const heard: GlimOpenDetail[] = [];
    const stop = onGlimOpen((detail) => heard.push(detail));
    openGlim();
    openGlim({ lotNumber: 7 });
    openGlim({ prefill: "Raise my budget" });
    stop();
    openGlim({ lotNumber: 9 });
    expect(heard).toEqual([{}, { lotNumber: 7 }, { prefill: "Raise my budget" }]);
  });

  it("does nothing with no panel listening", () => {
    expect(() => openGlim()).not.toThrow();
  });

  it('is the window event "glim:open"', () => {
    const listener = vi.fn();
    window.addEventListener(GLIM_OPEN_EVENT, listener);
    openGlim();
    expect(GLIM_OPEN_EVENT).toBe("glim:open");
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("eventSlugFromPath", () => {
  it("finds the slug on any page of an event", () => {
    expect(eventSlugFromPath("/e/gala-abc")).toBe("gala-abc");
    expect(eventSlugFromPath("/e/gala-abc/lots/07")).toBe("gala-abc");
    expect(eventSlugFromPath("/e/a%20b/")).toBe("a b");
  });

  it("is null outside an event", () => {
    expect(eventSlugFromPath("/")).toBeNull();
    expect(eventSlugFromPath("/e/")).toBeNull();
    expect(eventSlugFromPath("/api/demo")).toBeNull();
    expect(eventSlugFromPath("/e/%E0%A4%A")).toBeNull();
  });
});
