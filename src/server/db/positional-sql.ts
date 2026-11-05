import { sql, type SQL } from "drizzle-orm";

/**
 * A `$1, $2, ...` statement as Drizzle SQL with the same values bound, so SQL written for
 * node-postgres clients (the engine's COMMITMENTS_SQL, the event log's insert) also runs inside a
 * Drizzle transaction. Each value stays a single parameter, arrays included.
 */
export function positionalSql(text: string, values: readonly unknown[]): SQL {
  const parts = text.split(/\$(\d+)/);
  return sql.join(
    parts.map((part, index) => (index % 2 === 0 ? sql.raw(part) : sql.param(values[Number(part) - 1]))),
  );
}
