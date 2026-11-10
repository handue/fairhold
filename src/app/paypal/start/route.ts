/**
 * design/17 frame 1, "Opening PayPal…": what 09 opens the PayPal window on, inside the guest's
 * click, while the server creates the order. 09 then sends the window on to PayPal. ?e= is the
 * event's slug, for the line over the heading; ?amount= the hold in cents.
 */
import { formatUsd } from "@/server/paypal/money";
import { paypalStartResponse, windowEyebrow } from "@/server/paypal/window-page";

import { windowContextForEvent } from "../window-context";

/** Up to $100,000, which is past any hold an event allows. */
const AMOUNT = /^[1-9]\d{0,6}$/;

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("e");
  const amount = url.searchParams.get("amount");
  const context = slug ? await windowContextForEvent(slug, request) : null;
  const hold = amount && AMOUNT.test(amount) ? `a ${formatUsd(Number(amount))} hold` : "the hold";
  return paypalStartResponse({
    heading: "Opening PayPal…",
    detail: `PayPal’s page is loading.\nYou’ll approve ${hold} there.`,
    eyebrow: windowEyebrow(context),
    icon: "arrow",
  });
}
