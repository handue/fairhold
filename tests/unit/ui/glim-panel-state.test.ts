/** The corner's orb and bubbles, read from outside React through the same store. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onGlimOpen } from "@/ui/glim-events";
import { setGlimPanelOpen, setGuestTalked, toggleGlimPanel } from "@/ui/glim/panel-state";

describe("toggleGlimPanel", () => {
  beforeEach(() => {
    vi.stubGlobal("window", new EventTarget());
    setGlimPanelOpen(false);
    setGuestTalked(false);
  });

  afterEach(() => {
    setGlimPanelOpen(false);
    vi.unstubAllGlobals();
  });

  it("asks the panel to open when it is closed", () => {
    const heard = vi.fn();
    const stop = onGlimOpen(heard);
    toggleGlimPanel();
    expect(heard).toHaveBeenCalledOnce();
    stop();
  });

  it("closes an open panel without asking it to open", () => {
    const heard = vi.fn();
    const stop = onGlimOpen(() => {
      heard();
      setGlimPanelOpen(true);
    });
    toggleGlimPanel();
    toggleGlimPanel();
    expect(heard).toHaveBeenCalledOnce();
    toggleGlimPanel();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
  });
});
