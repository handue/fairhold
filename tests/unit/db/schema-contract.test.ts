/**
 * The database enums and the string unions each area keeps for the same values must agree: a
 * status the engine, the payments flow or Glim writes has to exist in Postgres, and every value
 * Postgres can return has to be one the reader handles. Runtime lists are compared here; the
 * type assertions are checked by `npm run typecheck`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { MIGRATIONS_FOLDER } from "@/server/db/migrate";
import * as schema from "@/server/db/schema";
import type { GlimChip, GlimPlanItemStatus, GlimPlanStatus } from "@/server/demo/plan";
import type { BidSource as ReplayBidSource, GlimActionKind as ReplayGlimActionKind } from "@/server/demo/replay";
import { LOT_CATEGORIES as TEMPLATE_CATEGORIES } from "@/server/demo/template";
import {
  BID_SOURCES,
  LIMIT_OWNERS,
  type EventStatus as EngineEventStatus,
  type LotStatus as EngineLotStatus,
} from "@/server/engine/types";
import type {
  GlimActionKind,
  GlimActionRecord,
  LotCategory as GlimLotCategory,
  PlanItemStatus,
  PlanStatus,
  RejectReason,
} from "@/server/glim/types";
import type { HoldStatus } from "@/server/paypal/hold-store";
import type { HoldKind } from "@/server/paypal/payments";
import {
  LOT_CATEGORIES as READ_MODEL_CATEGORIES,
  type EventStatus as ReadEventStatus,
  type LotStatus as ReadLotStatus,
} from "@/server/queries/types";
import { EVENT_LOG_TYPES } from "@/server/sse/notify";

type Values<Enum extends { enumValues: readonly string[] }> = Enum["enumValues"][number];

/** The snapshot drizzle-kit wrote with the latest migration. */
function latestSnapshot(): unknown {
  const journal = JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
    entries: { idx: number }[];
  };
  const latest = Math.max(...journal.entries.map((entry) => entry.idx));
  const file = `${String(latest).padStart(4, "0")}_snapshot.json`;
  return JSON.parse(readFileSync(path.join(MIGRATIONS_FOLDER, "meta", file), "utf8"));
}

describe("migrations", () => {
  // drizzle-kit's diff takes about a second, and more than the default 5 s on a loaded machine.
  it("cover every change to schema.ts (run npm run db:generate after editing it)", { timeout: 30_000 }, async () => {
    const { generateDrizzleJson, generateMigration } = await import("drizzle-kit/api");
    const pending = await generateMigration(
      latestSnapshot() as Parameters<typeof generateMigration>[0],
      generateDrizzleJson(schema),
    );
    expect(pending).toEqual([]);
  });
});

describe("schema enums", () => {
  it("match the engine's, the live layer's and the read models' value lists", () => {
    expect(schema.bidSource.enumValues).toEqual([...BID_SOURCES]);
    expect(schema.limitOwner.enumValues).toEqual([...LIMIT_OWNERS]);
    expect(schema.eventLogType.enumValues).toEqual([...EVENT_LOG_TYPES]);
    expect(schema.lotCategory.enumValues).toEqual([...READ_MODEL_CATEGORIES]);
    expect(schema.lotCategory.enumValues).toEqual([...TEMPLATE_CATEGORIES]);
  });

  it("match every area's string unions", () => {
    expectTypeOf<EngineEventStatus>().toEqualTypeOf<Values<typeof schema.eventStatus>>();
    expectTypeOf<ReadEventStatus>().toEqualTypeOf<Values<typeof schema.eventStatus>>();
    expectTypeOf<EngineLotStatus>().toEqualTypeOf<Values<typeof schema.lotStatus>>();
    expectTypeOf<ReadLotStatus>().toEqualTypeOf<Values<typeof schema.lotStatus>>();
    expectTypeOf<GlimLotCategory>().toEqualTypeOf<Values<typeof schema.lotCategory>>();

    expectTypeOf<HoldStatus>().toEqualTypeOf<Values<typeof schema.holdStatus>>();
    expectTypeOf<HoldKind>().toEqualTypeOf<Values<typeof schema.holdKind>>();

    expectTypeOf<PlanItemStatus>().toEqualTypeOf<Values<typeof schema.glimPlanItemStatus>>();
    expectTypeOf<GlimActionKind>().toEqualTypeOf<Values<typeof schema.glimActionKind>>();
    expectTypeOf<GlimActionRecord["decision"]>().toEqualTypeOf<Values<typeof schema.glimDecision>>();
    expectTypeOf<GlimActionRecord["chip"]>().toEqualTypeOf<Values<typeof schema.glimChip>>();
    // Glim only reads plans that are still running; ended and superseded ones are left out.
    expectTypeOf<PlanStatus>().toExtend<Values<typeof schema.glimPlanStatus>>();
    // glim_actions.reject_reason is text, so a new reason never needs a migration.
    expectTypeOf<RejectReason>().toExtend<string>();
  });

  it("cover what the seed writes", () => {
    expectTypeOf<ReplayBidSource>().toEqualTypeOf<Values<typeof schema.bidSource>>();
    expectTypeOf<ReplayGlimActionKind>().toExtend<Values<typeof schema.glimActionKind>>();
    expectTypeOf<GlimPlanStatus>().toExtend<Values<typeof schema.glimPlanStatus>>();
    expectTypeOf<GlimPlanItemStatus>().toExtend<Values<typeof schema.glimPlanItemStatus>>();
    expectTypeOf<GlimChip>().toEqualTypeOf<Values<typeof schema.glimChip>>();
  });
});
