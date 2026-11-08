/** Postgres text cannot hold a NUL, and a query with one throws (22021), so such input can match nothing. */
export function holdsNul(value: string): boolean {
  return value.includes("\u0000");
}
