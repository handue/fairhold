/** Joins class names, skipping empty values. Callers avoid conflicting utilities instead of merging them. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
