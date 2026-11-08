import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";

export interface LotRef {
  id: string;
  number: number;
  eventId: string;
}

/** A lot guests can see, by its event's slug and its number; drafts count as missing. */
export async function findLotRef(slug: string, lotNumber: number, db: Queryable = getPool()): Promise<LotRef | null> {
  const { rows } = await db.query<LotRef>(
    `select l.id, l.number, l.event_id as "eventId"
     from lots l
     join events e on e.id = l.event_id
     where e.slug = $1 and l.number = $2 and l.status <> 'draft'`,
    [slug, lotNumber],
  );
  return rows[0] ?? null;
}
