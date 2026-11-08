/** The stream's replay filter is SQL and its fan-out filter is canSeeStreamRow; they must agree. */
import { describe, expect, it } from "vitest";

import { appendEventLog } from "@/server/sse/notify";
import { latestPosition, readVisibleRows } from "@/server/sse/rows";
import { canSeeStreamRow, EVENT_LOG_TYPES, type StreamViewer } from "@/server/sse/types";

import { getTestDatabase } from "../../helpers/database";
import { createEvent, createPaddle } from "../engine/support/fixtures";

const { pool } = getTestDatabase();

describe("readVisibleRows", () => {
  it("returns exactly what canSeeStreamRow lets through, for every kind of viewer", async () => {
    const eventId = await createEvent(pool);
    const otherEventId = await createEvent(pool);
    const me = await createPaddle(pool, eventId, 1);
    const other = await createPaddle(pool, eventId, 2);
    const otherEventPaddle = await createPaddle(pool, otherEventId, 3);

    const rows = [null, me, other].flatMap((paddleId) =>
      EVENT_LOG_TYPES.map((type) => ({ eventId, paddleId, type, payload: { kind: "test" } })),
    );
    await appendEventLog(pool, rows);
    await appendEventLog(pool, [{ eventId: otherEventId, paddleId: otherEventPaddle, type: "hold", payload: { kind: "test" } }]);

    const viewers: StreamViewer[] = [
      { paddleId: null, isOrganizer: false },
      { paddleId: me, isOrganizer: false },
      { paddleId: other, isOrganizer: false },
      { paddleId: null, isOrganizer: true },
      { paddleId: me, isOrganizer: true },
    ];
    const through = await latestPosition(pool, eventId);
    for (const viewer of viewers) {
      const seen = await readVisibleRows(pool, { eventId, viewer, after: "0", through, limit: 1_000 });
      const expected = rows.filter((row) => canSeeStreamRow(row, viewer));
      expect(seen.map((row) => `${row.paddleId}:${row.type}`)).toEqual(expected.map((row) => `${row.paddleId}:${row.type}`));
    }
  });

  it("reads each row's position, channel, time and payload", async () => {
    const eventId = await createEvent(pool);
    const before = Date.now();
    const [written] = await appendEventLog(pool, [
      { eventId, paddleId: null, type: "event_status", payload: { kind: "event_closed", status: "closed" } },
    ]);
    const [row] = await readVisibleRows(pool, {
      eventId,
      viewer: { paddleId: null, isOrganizer: false },
      after: "0",
      through: await latestPosition(pool, eventId),
      limit: 10,
    });
    expect(row).toMatchObject({
      id: written?.id,
      type: "event_status",
      paddleId: null,
      payload: { kind: "event_closed", status: "closed" },
    });
    expect(Math.abs((row?.at ?? 0) - before)).toBeLessThan(5_000);
  });
});
