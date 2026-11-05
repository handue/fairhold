/** Money crosses the PayPal boundary as decimal strings; everywhere else it is integer USD cents. */

export const CURRENCY = "USD";

const PAYPAL_VALUE = /^(\d+)(?:\.(\d{1,2}))?$/;

export function assertCents(cents: number, label = "amount"): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new RangeError(`${label} must be a non-negative integer number of cents, got ${cents}`);
  }
}

/** 32000 -> "320.00" */
export function centsToPaypalValue(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;
  return `${dollars}.${remainder.toString().padStart(2, "0")}`;
}

/** "320.00" | "320" | "320.5" -> cents, parsed as text so no float rounding ever touches money. */
export function paypalValueToCents(value: string): number {
  const match = PAYPAL_VALUE.exec(value);
  if (!match) throw new RangeError(`not a PayPal USD amount: ${JSON.stringify(value)}`);
  const dollars = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(fraction);
  if (!Number.isSafeInteger(cents)) throw new RangeError(`PayPal amount out of range: ${value}`);
  return cents;
}

/** "$500" or "$12.50", for plain-text pages and logs. */
export function formatUsd(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100).toLocaleString("en-US");
  const remainder = cents % 100;
  return remainder === 0 ? `$${dollars}` : `$${dollars}.${remainder.toString().padStart(2, "0")}`;
}
