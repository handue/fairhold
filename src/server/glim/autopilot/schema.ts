/**
 * The one JSON object the autopilot model returns (structured outputs, output_config.format).
 * The schema is strict: closed objects, every property required. JSON Schema there cannot carry
 * numeric bounds, so parseDecision adds them with Zod, as tools.ts does for the chat tools. A
 * reply that is not JSON or fails these checks is an invalid decision, and the rule decides.
 */
import { z } from "zod";

import { dollarsToCents } from "../money";

import { DECISION_ACTIONS, DECISION_REASONS, type AutopilotDecision } from "./types";

export const MAX_DECISION_LOTS = 12;
export const MAX_WHY_LENGTH = 400;

export const DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "lots", "raise_to_dollars", "reason", "why"],
  properties: {
    action: { type: "string", enum: [...DECISION_ACTIONS] },
    lots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lot_number", "priority", "max_dollars"],
        properties: {
          lot_number: { type: "integer" },
          priority: { type: "integer" },
          max_dollars: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
      },
    },
    raise_to_dollars: { anyOf: [{ type: "integer" }, { type: "null" }] },
    reason: { type: "string", enum: [...DECISION_REASONS] },
    why: { type: "string" },
  },
} as const;

const wholeDollars = z.number().int().min(1).max(1_000_000);

const decisionParser = z
  .object({
    action: z.enum(DECISION_ACTIONS),
    lots: z
      .array(
        z
          .object({
            lot_number: z.number().int().min(1).max(9_999),
            priority: z.number().int().min(1).max(99),
            max_dollars: wholeDollars.nullable(),
          })
          .strict(),
      )
      .max(MAX_DECISION_LOTS)
      .refine((lots) => new Set(lots.map((lot) => lot.lot_number)).size === lots.length, "lot numbers must be unique"),
    raise_to_dollars: wholeDollars.nullable(),
    reason: z.enum(DECISION_REASONS),
    why: z.string().max(MAX_WHY_LENGTH),
  })
  .strict();

export type ParsedDecision = { ok: true; decision: AutopilotDecision } | { ok: false; message: string };

/** Reads the model's reply text into a decision in cents (§4.6). */
export function parseDecision(text: string): ParsedDecision {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "The reply was not JSON." };
  }
  return decisionFromJson(value);
}

export function decisionFromJson(value: unknown): ParsedDecision {
  const parsed = decisionParser.safeParse(value);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "decision"}: ${issue.message}`);
    return { ok: false, message: `The decision was not usable (${problems.join("; ")}).` };
  }
  const { data } = parsed;
  return {
    ok: true,
    decision: {
      action: data.action,
      lots: data.lots.map((lot) => ({
        lotNumber: lot.lot_number,
        priority: lot.priority,
        maxCents: lot.max_dollars === null ? null : dollarsToCents(lot.max_dollars),
      })),
      raiseToCents: data.raise_to_dollars === null ? null : dollarsToCents(data.raise_to_dollars),
      reason: data.reason,
      why: data.why,
    },
  };
}

/** The decision as the model would have written it, for fixtures and the run log. */
export function decisionToJson(decision: AutopilotDecision): Record<string, unknown> {
  return {
    action: decision.action,
    lots: decision.lots.map((lot) => ({
      lot_number: lot.lotNumber,
      priority: lot.priority,
      max_dollars: lot.maxCents === null ? null : lot.maxCents / 100,
    })),
    raise_to_dollars: decision.raiseToCents === null ? null : decision.raiseToCents / 100,
    reason: decision.reason,
    why: decision.why,
  };
}
