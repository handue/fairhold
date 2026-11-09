/**
 * The heart on 05. Favorites are the guest's own list, not auction state, so they are written here
 * rather than through the engine. The change reaches the guest's other tabs on their own channel;
 * Glim reads the table when it plans, and nothing about the auction depends on it.
 */
import { getPool } from "@/server/db/client";
import { withTransaction } from "@/server/db/transaction";
import { appendEventLog } from "@/server/sse/notify";
import type { FavoriteChangedPayload } from "@/server/sse/types";

import type pg from "pg";

export interface SetFavoriteInput {
  eventId: string;
  paddleId: string;
  lotId: string;
  lotNumber: number;
  isFavorite: boolean;
}

/** Sets the heart to this value; doing so twice changes nothing and writes no second row. */
export async function setFavorite(input: SetFavoriteInput, pool: pg.Pool = getPool()): Promise<void> {
  const { eventId, paddleId, lotId, lotNumber, isFavorite } = input;
  await withTransaction(pool, async (client) => {
    const { rowCount } = isFavorite
      ? await client.query("insert into favorites (paddle_id, lot_id) values ($1, $2) on conflict do nothing", [paddleId, lotId])
      : await client.query("delete from favorites where paddle_id = $1 and lot_id = $2", [paddleId, lotId]);
    if (rowCount !== 1) return;
    const payload: FavoriteChangedPayload = { kind: "favorite_changed", lotId, lotNumber, isFavorite };
    await appendEventLog(client, [{ eventId, paddleId, type: "bid", payload }]);
  });
}
