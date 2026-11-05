import { setTimeout as sleep } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createEngineTick, type EngineTick } from "@/server/engine";

import { getTestDatabase } from "../../helpers/database";

import { createEvent, createLot, expireLot, lotRow } from "./support/fixtures";

const { pool, url } = getTestDatabase();
const running: EngineTick[] = [];
const errors: unknown[] = [];

function startTick(options: Parameters<typeof createEngineTick>[0] = {}): EngineTick {
  const tick = createEngineTick({
    intervalMs: 25,
    connectionString: url,
    onError: (error) => errors.push(error),
    ...options,
  });
  running.push(tick);
  return tick;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((tick) => tick.stop()));
  errors.length = 0;
});

describe("engine tick", () => {
  it("closes due lots within a round or two", async () => {
    const eventId = await createEvent(pool);
    const lotId = await createLot(pool, eventId, { number: 1, startingBidCents: 1_000, minRaiseCents: 100 });
    startTick();
    await expireLot(pool, lotId);
    await expect.poll(async () => (await lotRow(pool, lotId)).status, { timeout: 5_000 }).toBe("closed");
    expect(errors).toEqual([]);
  });

  it("runs in one process at a time and hands over when the leader stops", async () => {
    const rounds = [0, 0];
    const countingTask = (index: 0 | 1) => ({
      name: "count",
      run: async () => {
        rounds[index] = (rounds[index] ?? 0) + 1;
      },
    });
    const ticks = [startTick({ tasks: [countingTask(0)] }), startTick({ tasks: [countingTask(1)] })] as const;

    await expect.poll(() => ticks.some((tick) => tick.isLeader), { timeout: 5_000 }).toBe(true);
    await sleep(300);
    const leaderIndex = ticks[0].isLeader ? 0 : 1;
    const followerIndex = leaderIndex === 0 ? 1 : 0;
    expect(ticks[followerIndex].isLeader).toBe(false);
    expect(rounds[leaderIndex]).toBeGreaterThan(2);
    expect(rounds[followerIndex]).toBe(0);

    await ticks[leaderIndex].stop();
    await expect.poll(() => ticks[followerIndex].isLeader, { timeout: 5_000 }).toBe(true);
    await expect.poll(() => rounds[followerIndex], { timeout: 5_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  it("reports a failing task and keeps ticking", async () => {
    let calls = 0;
    startTick({
      tasks: [
        {
          name: "flaky",
          run: async () => {
            calls += 1;
            if (calls === 1) throw new Error("first round fails");
          },
        },
      ],
    });
    await expect.poll(() => calls, { timeout: 5_000 }).toBeGreaterThan(2);
    expect(errors).toEqual([expect.objectContaining({ message: "first round fails" })]);
  });
});
