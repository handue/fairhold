/**
 * Adversarial review (Day 1): the amount guard only sees figures written as "$380", "US$380",
 * "USD 380", or "380 dollars/USD/bucks". Dollar figures in other common shapes pass through, so a
 * made-up or injected amount reaches the guest even though the build plan says any figure not in
 * the validated plan or the snapshot replaces the reply with a template.
 *
 * The allowed set here is the golden plan's: $380, $120 and the $500 hold.
 */
import { describe, expect, it } from "vitest";

import { checkReplyAmounts, guardReply } from "@/server/glim/amountGuard";

const allowed = new Set([38_000, 12_000, 50_000]);

describe("review: the amount guard catches every dollar figure Glim writes", () => {
  it.each([
    ["a trailing dollar sign", "I'll bid up to 400$ on the Chef's Table."],
    ["US dollars spelled after the number", "Your limit on the cabin is 900 US dollars."],
    ["a second figure in a list after a checked one", "I set the spa to $120 and the cabin to 640."],
    ["the upper end of a range", "Chef's Table goes to $380, then 420 if someone outbids you."],
    ["two spaces after the sign", "I'll go to $  900 on the cabin."],
    ["a fullwidth dollar sign", "I'll go to ＄900 on the cabin."],
    ["fullwidth digits", "I'll go to $９００ on the cabin."],
    ["a spelled-out amount without the word dollars", "I'll keep the cabin at nine hundred."],
  ])("flags %s", (_shape, text) => {
    // Failed before the Day 1 fix: checkReplyAmounts reports ok, so guardReply would show this text unchanged.
    expect(checkReplyAmounts(text, allowed).ok).toBe(false);
    expect(guardReply(text, allowed, "template").replaced).toBe(true);
  });
});
