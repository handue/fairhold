/**
 * Adversarial review (Day 1): backHrefFor checks the origin of `new URL(next, BASE)` and then
 * returns its pathname, but URL parsing removes dot segments, so "/.//evil.example" comes back as
 * the protocol-relative "//evil.example". The PayPal window page puts that in its link and, for
 * every non-error outcome, in window.location.replace after 1.5 s: an open redirect on the page
 * a guest sees right after approving or canceling a PayPal hold.
 *
 * Attack: an attacker with their own canceled hold (any demo guest can make one) shares
 * /paypal/cancel?hold=<that id>&next=/.//evil.example; whoever opens it lands on evil.example.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as cancelGet } from "@/app/paypal/cancel/route";
import type { HoldRecord } from "@/server/paypal/hold-store";
import { cancelHoldApproval } from "@/server/paypal/holds";
import { backHrefFor } from "@/server/paypal/window-page";

vi.mock("@/server/paypal/holds", () => ({ completeHoldApproval: vi.fn(), cancelHoldApproval: vi.fn() }));

const canceledHold: HoldRecord = {
  id: "hold-1",
  eventId: "event-1",
  eventSlug: "riverside",
  paddleId: "paddle-142",
  kind: "paypal",
  status: "canceled",
  amountCents: 500_00,
  paypalOrderId: "ORDER1",
  originalAuthorizationId: null,
  currentAuthorizationId: null,
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("review: the PayPal window's back link stays on this origin", () => {
  it.each(["/.//evil.example", "/x/..//evil.example", "/%2e//evil.example", "/./\\evil.example"])(
    "falls back to the event page for %j",
    (next) => {
      // Failed before the Day 1 fix: each returns "//evil.example".
      expect(backHrefFor(next, "riverside")).toBe("/e/riverside");
    },
  );

  it("never sends the canceled-hold page to another site", async () => {
    vi.mocked(cancelHoldApproval).mockResolvedValue({ kind: "not_pending", hold: canceledHold });

    const response = await cancelGet(
      new Request("https://fairhold.example/paypal/cancel?hold=hold-1&next=%2F.%2F%2Fevil.example"),
    );
    const html = await response.text();

    expect(html).toContain('"outcome":"canceled"');
    // Failed before the Day 1 fix: the page links to and auto-redirects to //evil.example.
    expect(html).not.toContain("//evil.example");
  });
});
