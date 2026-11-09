/**
 * PayPal's cancel_url: the buyer backed out on PayPal's page. Marks the pending hold canceled and
 * tells the opener. PayPal appends ?token=<order id> to the ?hold=<hold id>&next=<path> that
 * Fairhold put in the URL, and without that token nothing changes (cancelHoldApproval).
 */
import { cancelHoldApproval, type CancelOutcome } from "@/server/paypal/holds";
import {
  backHrefFor,
  paypalWindowResponse,
  retryHrefFor,
  windowEyebrow,
  type PaypalWindowPage,
} from "@/server/paypal/window-page";

import { windowContextForHold } from "../window-context";

/** design/17 frame 4, "Canceled"; the other answers take its layout with their own lines. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const holdId = url.searchParams.get("hold");
  const next = url.searchParams.get("next");
  if (!holdId) return paypalWindowResponse(unknownHold(next, 400));

  try {
    const [outcome, context] = await Promise.all([
      cancelHoldApproval({ holdId, orderId: url.searchParams.get("token") }),
      windowContextForHold(holdId),
    ]);
    return paypalWindowResponse({ ...pageFor(outcome, next), eyebrow: windowEyebrow(context) });
  } catch (error) {
    console.error(`[paypal/cancel] hold ${holdId}:`, error);
    return paypalWindowResponse({
      status: 500,
      outcome: "error",
      holdId,
      heading: "Something went wrong",
      detail: "Nothing was held. Please go back to the auction.",
      backHref: backHrefFor(next, null),
    });
  }
}

function pageFor(outcome: CancelOutcome, next: string | null): PaypalWindowPage {
  if (outcome.kind === "not_found") return unknownHold(next, 404);
  const { hold } = outcome;
  const shared = { holdId: hold.id, backHref: backHrefFor(next, hold.eventSlug) };

  if (outcome.kind === "order_mismatch") {
    return {
      ...shared,
      status: 409,
      outcome: "error",
      heading: "This PayPal window belongs to another hold",
      detail: "Nothing changed. Please go back to the auction.",
    };
  }
  if (outcome.kind === "not_pending" && hold.status === "authorized") {
    // Canceled after an approval had already gone through: the hold stands.
    return {
      ...shared,
      status: 200,
      outcome: "approved",
      heading: "Bidding power is already set",
      detail: "PayPal confirmed this hold before the cancel.\nYou can close this window.",
    };
  }
  return {
    ...shared,
    // After a full-page redirect there is no other tab to try again from.
    backHref: retryHrefFor(next, hold.eventSlug),
    status: 200,
    outcome: "canceled",
    heading: "Canceled",
    detail: "Nothing was held.\nYou can close this window.",
  };
}

function unknownHold(next: string | null, status: number): PaypalWindowPage {
  return {
    status,
    outcome: "error",
    holdId: null,
    heading: "We could not find this hold",
    detail: "Nothing was held. Please go back to the auction.",
    backHref: backHrefFor(next, null),
  };
}
