/** Distinct ids in ascending order, the order rows are locked in. */
export function sortedUnique(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort();
}
