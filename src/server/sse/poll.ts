import { getPool } from "@/server/db/client";
import type { Queryable } from "@/server/db/transaction";
import { getDevelopmentSwitches } from "@/server/lib/env";

import { databaseNow, latestPosition, readVisibleRows, recentPosition } from "./rows";
import { STREAM_REPLAY_LIMIT, type StreamPollResponse, type StreamViewer } from "./types";

/** One poll: what a stream would have sent since `after`. The same query, the same viewer filter. */
export async function readPollAnswer(
  eventId: string,
  viewer: StreamViewer,
  requestedAfter: string | null,
  db: Queryable = getPool(),
): Promise<StreamPollResponse> {
  const position = await latestPosition(db, eventId);
  const after = requestedAfter ?? (await recentPosition(db, eventId));
  const rows = await readVisibleRows(db, { eventId, viewer, after, through: position, limit: STREAM_REPLAY_LIMIT + 1 });
  const serverNow = getDevelopmentSwitches().freezeClockAt ?? (await databaseNow(db));
  const resync = rows.length > STREAM_REPLAY_LIMIT;
  return { serverNow, after, position, rows: resync ? [] : rows, resync };
}
