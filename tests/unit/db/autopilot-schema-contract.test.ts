/**
 * The autopilot's enums and its TypeScript lists must agree, like the contract in
 * schema-contract.test.ts for the rest of the schema (kept in its own file, so that one stays
 * as it is).
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import * as schema from "@/server/db/schema";
import {
  AUTOPILOT_DECIDERS,
  AUTOPILOT_OUTCOMES,
  type AutopilotDecider,
  type AutopilotOutcome,
} from "@/server/glim/autopilot/types";
import type { GlimActionKind } from "@/server/glim/types";

type Values<Enum extends { enumValues: readonly string[] }> = Enum["enumValues"][number];

describe("autopilot schema enums", () => {
  it("match the autopilot's outcome and decider lists", () => {
    expect(schema.glimAutopilotOutcome.enumValues).toEqual([...AUTOPILOT_OUTCOMES]);
    expect(schema.glimAutopilotDecider.enumValues).toEqual([...AUTOPILOT_DECIDERS]);
    expectTypeOf<AutopilotOutcome>().toEqualTypeOf<Values<typeof schema.glimAutopilotOutcome>>();
    expectTypeOf<AutopilotDecider>().toEqualTypeOf<Values<typeof schema.glimAutopilotDecider>>();
  });

  it("include the autopilot's action kinds", () => {
    expect(schema.glimActionKind.enumValues).toEqual(expect.arrayContaining(["autopilot_changed", "autopilot_raise_prepared"]));
    expectTypeOf<"autopilot_changed" | "autopilot_raise_prepared">().toExtend<GlimActionKind>();
  });
});
