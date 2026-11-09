/**
 * A PayPal window approved after it can no longer count (bidding closed while it was open, or a
 * second window for the same raise) is authorized by PayPal, refused by the swap and voided. The row
 * keeps PayPal's authorization: status 'voided', authorized_at set, and it is the newest row. It is
 * never the guest's hold:
 *
 * - 11's receipt (src/server/queries/receipt-view.ts) keeps reading the real hold, and a guest who
 *   won nothing doesn't read "Hold released" while that hold still waits for the organizer's charge.
 * - Glim's closing card (loadClosingFacts in src/server/chat/view.ts) doesn't say "You paid … and
 *   the other $X was released" with X counted from the refused amount.
 *
 * Found by the Day 3 review; src/server/holds/bidding-hold.ts now decides which hold is the guest's.
 */
import { describe, expect, it } from "vitest";

import { POST as openWindow } from "@/app/api/holds/[slug]/route";
import { GET as returnPage } from "@/app/paypal/return/route";
import { getBiddingPower, placeBid } from "@/server/engine";
import { getReceiptView } from "@/server/queries/receipt-view";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { postJson } from "../api/support";
import { clickStartBidding, createChatGala, lastPlanCard, readView, sendMessage, type ChatGala } from "../chat/support";

const { pool } = getTestDatabase();

/** Jamie opens a PayPal window for $800 while bidding runs (09's raise, or V3's Approve). */
async function openRaiseWindow(gala: ChatGala): Promise<string> {
  const response = await openWindow(postJson(`/api/holds/${gala.slug}`, { amountCents: 80_000 }, { cookie: gala.cookie }), {
    params: Promise.resolve({ slug: gala.slug }),
  });
  expect(response.status).toBe(201);
  const { approvalUrl } = (await response.json()) as { approvalUrl: string };
  return approvalUrl;
}

/** The demo menu's Close bidding now, as the existing chat tests close a gala. */
async function closeBidding(gala: ChatGala): Promise<void> {
  await pool.query(
    "update lots set status = 'closed', closes_at = now(), winning_paddle_id = high_paddle_id, winning_cents = current_bid_cents where event_id = $1",
    [gala.eventId],
  );
  await pool.query("update events set status = 'closed', closed_at = now() where id = $1", [gala.eventId]);
}

/** The guest approves the window after the close: PayPal authorizes, the swap refuses and voids it. */
async function approveTooLate(approvalUrl: string, paddleId: string): Promise<void> {
  const page = await returnPage(new Request(approvalUrl));
  expect(await page.text()).toContain('"outcome":"refused"');
  const { rows } = await pool.query<{ amount_cents: number; status: string; authorized: boolean }>(
    "select amount_cents, status::text as status, authorized_at is not null as authorized from holds where paddle_id = $1 order by created_at",
    [paddleId],
  );
  // The $500 hold is still the bidding power; the $800 approval was voided.
  expect(rows).toEqual([
    { amount_cents: 50_000, status: "authorized", authorized: true },
    { amount_cents: 80_000, status: "voided", authorized: true },
  ]);
  expect((await getBiddingPower([paddleId], pool)).get(paddleId)).toMatchObject({ holdCents: 50_000 });
}

describe("a refused late approval is never the guest's hold", () => {
  it("leaves 11's pending receipt and Glim's closing card on the $500 hold, before any charge", async () => {
    const gala = await createChatGala(pool);
    const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    await clickStartBidding(gala, card.planId);
    const approvalUrl = await openRaiseWindow(gala);
    await closeBidding(gala);
    await approveTooLate(approvalUrl, gala.jamie);

    const receipt = await getReceiptView({ slug: gala.slug, paddleNumber: 142 });
    // Fails today: hold.cents is 80000 and releaseCents 39000, counted from the voided approval.
    expect.soft(receipt).toMatchObject({ phase: "pending", payCents: 41_000, releaseCents: 9_000, hold: { cents: 50_000 } });

    // Fails today: "You won both lots in your plan. You paid $410 with PayPal, and the other $390 was released."
    expect.soft((await readView(gala)).closing?.line).toBe(
      "You won both lots in your plan. You’ll pay $410 with PayPal, and the other $90 will be released.",
    );
  });

  it("does not tell a guest who won nothing that a hold still waiting for the charge was released", async () => {
    const gala = await createChatGala(pool);
    // The rival takes Chef's Table, Jamie's only bid.
    expect(await placeBid(gala.rival, gala.lots.chef, 40_000, "guest", { pool })).toMatchObject({ ok: true });
    const approvalUrl = await openRaiseWindow(gala);
    await closeBidding(gala);
    await approveTooLate(approvalUrl, gala.jamie);

    const receipt = await getReceiptView({ slug: gala.slug, paddleNumber: 142 });
    // Fails today: phase "released" (11 reads "Hold released", Paid · Released, "Your hold is already
    // released.") with an $800 hold, while the $500 authorization is still held.
    expect.soft(receipt).toMatchObject({ phase: "release_pending", payCents: 0, releaseCents: 50_000, hold: { cents: 50_000 } });

    // Fails today: "… All $800 was released."
    expect.soft((await readView(gala)).closing?.line).toBe("You didn’t win a lot tonight, so you won’t be charged. All $500 will be released.");
  });
});
