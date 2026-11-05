/**
 * PayPal's return_url: the buyer approved the hold. Authorizes the order, stores the authorization
 * on the hold and tells the opener. PayPal appends ?token=<order id>&PayerID=... to the
 * ?hold=<hold id>&next=<path> that Fairhold put in the URL.
 */
import { completeHoldApproval, type ApprovalOutcome } from "@/server/paypal/holds";
import { formatUsd } from "@/server/paypal/money";
import { backHrefFor, paypalWindowResponse, type PaypalWindowPage } from "@/server/paypal/window-page";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const holdId = url.searchParams.get("hold");
  const next = url.searchParams.get("next");
  if (!holdId) return paypalWindowResponse(unknownHold(next, 400));

  try {
    const outcome = await completeHoldApproval({ holdId, orderId: url.searchParams.get("token") });
    return paypalWindowResponse(pageFor(outcome, next));
  } catch (error) {
    console.error(`[paypal/return] hold ${holdId}:`, error);
    return paypalWindowResponse({
      status: 500,
      outcome: "error",
      holdId: null,
      heading: "Something went wrong",
      detail: "We could not confirm this hold. Nothing new was charged. Please go back and try again.",
      backHref: backHrefFor(next, null),
    });
  }
}

function pageFor(outcome: ApprovalOutcome, next: string | null): PaypalWindowPage {
  if (outcome.kind === "not_found") return unknownHold(next, 404);
  const { hold } = outcome;
  const shared = { holdId: hold.id, backHref: backHrefFor(next, hold.eventSlug) };

  switch (outcome.kind) {
    case "authorized":
      return {
        ...shared,
        status: 200,
        outcome: "approved",
        heading: "Bidding power is set",
        detail: `${formatUsd(hold.amountCents)} is on hold with PayPal. You pay only for what you win. You can close this window.`,
      };
    case "pending":
      return {
        ...shared,
        status: 202,
        outcome: "pending",
        heading: "Still confirming with PayPal",
        detail: "This can take a moment. Your bidding power updates as soon as PayPal confirms the hold.",
      };
    case "declined":
      return {
        ...shared,
        status: 200,
        outcome: "declined",
        heading: "PayPal declined the hold",
        detail: "Nothing was held. You can try again with another amount or payment method.",
      };
    case "failed":
      return {
        ...shared,
        status: 502,
        outcome: "error",
        heading: "PayPal could not place the hold",
        detail: "Nothing was held. Please go back and try again.",
      };
    case "not_pending":
      return hold.status === "canceled"
        ? {
            ...shared,
            status: 200,
            outcome: "canceled",
            heading: "This hold was canceled",
            detail: "Nothing is held for it. You can start a new hold from the auction.",
          }
        : {
            ...shared,
            status: 409,
            outcome: "error",
            heading: "This hold is no longer open",
            detail: "Your current bidding power is shown in the auction.",
          };
    case "order_mismatch":
      return {
        ...shared,
        status: 409,
        outcome: "error",
        heading: "This PayPal approval belongs to another hold",
        detail: "Nothing changed. Please go back to the auction and try again.",
      };
    case "refused":
      return { ...shared, status: 409, outcome: "refused", ...refusedCopy(outcome) };
  }
}

type RefusedApproval = Extract<ApprovalOutcome, { kind: "refused" }>;

function refusedCopy({ hold, refusal }: RefusedApproval): Pick<PaypalWindowPage, "heading" | "detail"> {
  // Voided now, or by the sweep when PayPal could not be reached.
  const released = hold.status === "voided" ? "was released" : "is being released";
  const amount = formatUsd(hold.amountCents);
  switch (refusal.reason) {
    case "not_a_raise":
      return {
        heading: `Your bidding power stays at ${formatUsd(refusal.currentHoldCents)}`,
        detail: `You already hold ${formatUsd(refusal.currentHoldCents)} with PayPal, so this ${amount} hold ${released}. Nothing changed.`,
      };
    case "below_commitments":
      return {
        heading: "This hold is too small for your bids",
        detail: `Your bids already need ${formatUsd(refusal.committedCents)} of bidding power, so this ${amount} hold ${released}. Choose at least ${formatUsd(refusal.committedCents)}.`,
      };
    case "bidding_ended":
      return {
        heading: "Bidding has closed",
        detail: `PayPal approved this ${amount} hold after bidding closed, so it ${released}.`,
      };
  }
}

function unknownHold(next: string | null, status: number): PaypalWindowPage {
  return {
    status,
    outcome: "error",
    holdId: null,
    heading: "We could not find this hold",
    detail: "Nothing changed. Please go back to the auction and try again.",
    backHref: backHrefFor(next, null),
  };
}
