/** Whole US dollars to integer cents, the only unit money is stored in. */
export function dollars(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`Expected a whole, non-negative dollar amount, got ${amount}`);
  }
  return amount * 100;
}
