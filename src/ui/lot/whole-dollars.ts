/** "$380", "380", "1,000": whole dollars, as cents. Null for anything else. */
export function parseWholeDollars(text: string): number | null {
  const digits = text.replace(/[$,\s]/g, "");
  if (!/^\d{1,7}$/.test(digits)) return null;
  const dollars = Number(digits);
  return dollars > 0 ? dollars * 100 : null;
}
