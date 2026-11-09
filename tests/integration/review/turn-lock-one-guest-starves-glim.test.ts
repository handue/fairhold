/**
 * Review finding (wave 2): MAX_OPEN_TURNS counts messages waiting for their own paddle's lock as well
 * as turns running, and a waiter holds its slot for up to 75 s. One guest sending 16 messages at once
 * (the route allows 30 a minute) turns every other guest in the process away with glim_busy, at no
 * model cost to them. Until the fix, this fails.
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { acquireTurnLock } from "@/server/chat/lock";

import { getTestDatabase } from "../../helpers/database";

// Attaches this file's database, which the lock's own connections read through DATABASE_URL.
getTestDatabase();

describe("Glim's turn slots", () => {
  it("one guest's queued messages do not refuse another guest", async () => {
    const noisy = randomUUID();
    const held = await acquireTurnLock(noisy);
    const queued = Array.from({ length: 15 }, () =>
      acquireTurnLock(noisy, { waitMs: 2_000 }).then(
        (lock) => lock.release(),
        () => {},
      ),
    );

    let outcome: unknown = "got a turn";
    try {
      const other = await acquireTurnLock(randomUUID(), { waitMs: 1_000 });
      await other.release();
    } catch (error) {
      outcome = error;
    }
    await held.release();
    await Promise.all(queued);

    expect(outcome).toBe("got a turn");
  });
});
