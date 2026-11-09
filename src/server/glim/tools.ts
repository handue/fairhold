/**
 * Glim's three tools. None of them acts: each returns a proposal that code validates before the
 * guest sees it. Schemas are strict (grammar-constrained); the bounds strict mode cannot express
 * (minimum, maximum) are enforced by the Zod parsers below.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import { dollarsToCents } from "./money";
import type { HoldSuggestionIntent, PlanIntent } from "./types";

type Tool = Anthropic.Beta.BetaTool;

const nullableInteger = (description: string) => ({
  anyOf: [{ type: "integer" }, { type: "null" }],
  description,
});

const planInputSchema: Tool["input_schema"] = {
  type: "object",
  properties: {
    budget_dollars: nullableInteger(
      "The most the guest wants to spend across every lot in the plan, in whole US dollars, exactly as they said it. null when they gave no budget.",
    ),
    items: {
      type: "array",
      minItems: 1,
      description: "The lots in the plan.",
      items: {
        type: "object",
        properties: {
          lot_number: {
            type: "integer",
            description: "The lot's number from the state snapshot, without leading zeros: Lot 07 is 7.",
          },
          priority: {
            type: "integer",
            description: "1 for the lot the guest wants most, 2 for the next, and so on. Lots wanted equally share a priority.",
          },
          cap_dollars: nullableInteger(
            "The guest's own upper limit for this lot in whole US dollars, only when they named one (\"yoga only under $80\" is 80). null otherwise; code then sets the maximum from the budget and priorities.",
          ),
        },
        required: ["lot_number", "priority", "cap_dollars"],
        additionalProperties: false,
      },
    },
    backup_lot_numbers: {
      type: "array",
      description:
        "Lots the guest said Glim may switch to if a planned lot gets away (\"the wine tasting is my backup\"), by lot number. Empty when they named none; Fairhold adds the lots they hearted.",
      items: { type: "integer" },
    },
    excluded_lot_numbers: {
      type: "array",
      description: "Lots the guest ruled out (\"not the cabin\"), by lot number; Glim never bids on them. Empty when they ruled out none.",
      items: { type: "integer" },
    },
  },
  required: ["budget_dollars", "items", "backup_lot_numbers", "excluded_lot_numbers"],
  additionalProperties: false,
};

// eager_input_streaming stays unset: these inputs are a few dozen tokens, so streaming them early
// saves nothing, and the default buffering keeps the server-side schema check.
export const GLIM_TOOLS: Tool[] = [
  {
    name: "propose_plan",
    description:
      "Propose a bidding plan for the guest to review. Call it when the guest has no plan yet and has told you a budget and the lots they want. You state only intent: the budget, each lot's priority, any cap the guest named, any lots they named as backups and any lots they ruled out. Fairhold's code sets each lot's maximum (caps first, the rest of the budget to priority 1, every maximum at or above the lot's next minimum bid), checks it against the guest's bidding power and shows a plan card. Nothing is bid until the guest clicks Start bidding.",
    strict: true,
    input_schema: planInputSchema,
  },
  {
    name: "propose_change",
    description:
      "Propose a change to the guest's existing plan: dropping a lot, adding one, changing a cap or the budget, or naming a backup or a lot to rule out. Send the complete revised plan (every lot that stays, with its priority and cap, plus new lots; leave out lots to drop). To keep a lot's maximum unchanged, set its cap to its current maximum from the snapshot; pass a budget only if the guest changed it. Bids already placed stand. Fairhold checks the change and shows it as a card; nothing changes until the guest confirms.",
    strict: true,
    input_schema: planInputSchema,
  },
  {
    name: "suggest_hold_amount",
    description:
      "Suggest a bidding power amount (a PayPal hold). Call it when the guest asks how much to hold, or when what they want doesn't fit within their current bidding power. Fairhold shows a button that opens the bidding power page with this amount; the guest approves any new hold themselves in a PayPal window. You never create or change a hold.",
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        amount_dollars: {
          type: "integer",
          description: "The suggested total bidding power in whole US dollars: the full new amount, not the increase.",
        },
        lot_numbers: {
          type: "array",
          description: "The lots this amount is meant to cover.",
          items: { type: "integer" },
        },
      },
      required: ["amount_dollars", "lot_numbers"],
      additionalProperties: false,
    },
  },
];

/** auto is the only forcing mode Opus 5.5 accepts; one tool per reply keeps one card per reply. */
export const GLIM_TOOL_CHOICE: Anthropic.Beta.BetaToolChoiceAuto = {
  type: "auto",
  disable_parallel_tool_use: true,
};

const wholeDollars = z.number().int().min(1).max(1_000_000);

const lotNumbers = z.array(z.number().int().min(1).max(9_999)).max(50);

const planInputParser = z.object({
  budget_dollars: wholeDollars.nullable(),
  items: z
    .array(
      z.object({
        lot_number: z.number().int().min(1).max(9_999),
        priority: z.number().int(),
        cap_dollars: wholeDollars.nullable(),
      }),
    )
    .min(1)
    .max(50),
  // Required by the strict schema; the defaults keep proposals recorded before them parsing.
  backup_lot_numbers: lotNumbers.default([]),
  excluded_lot_numbers: lotNumbers.default([]),
});

const holdInputParser = z.object({
  amount_dollars: wholeDollars,
  lot_numbers: z.array(z.number().int().min(1).max(9_999)).max(50),
});

export type GlimToolCall =
  | { kind: "plan"; intent: PlanIntent }
  | { kind: "hold"; intent: HoldSuggestionIntent };

export type ParsedToolCall = { ok: true; call: GlimToolCall } | { ok: false; message: string };

/**
 * Converts a tool_use block into an intent in cents. Priorities are left as given so the validator
 * can report a bad one; everything else that would be nonsense (a $0 cap) is rejected here.
 */
export function parseToolCall(name: string, input: unknown): ParsedToolCall {
  if (name === "propose_plan" || name === "propose_change") {
    const parsed = planInputParser.safeParse(input);
    if (!parsed.success) return { ok: false, message: describeZodError(name, parsed.error) };
    const backups = [...new Set(parsed.data.backup_lot_numbers)];
    const excluded = [...new Set(parsed.data.excluded_lot_numbers)];
    return {
      ok: true,
      call: {
        kind: "plan",
        intent: {
          tool: name,
          budgetCents: parsed.data.budget_dollars === null ? null : dollarsToCents(parsed.data.budget_dollars),
          items: parsed.data.items.map((item) => ({
            lotNumber: item.lot_number,
            priority: item.priority,
            capCents: item.cap_dollars === null ? null : dollarsToCents(item.cap_dollars),
          })),
          ...(backups.length > 0 ? { backupLotNumbers: backups } : {}),
          ...(excluded.length > 0 ? { excludedLotNumbers: excluded } : {}),
        },
      },
    };
  }
  if (name === "suggest_hold_amount") {
    const parsed = holdInputParser.safeParse(input);
    if (!parsed.success) return { ok: false, message: describeZodError(name, parsed.error) };
    return {
      ok: true,
      call: {
        kind: "hold",
        intent: { amountCents: dollarsToCents(parsed.data.amount_dollars), lotNumbers: parsed.data.lot_numbers },
      },
    };
  }
  return { ok: false, message: `Glim has no tool named ${JSON.stringify(name)}.` };
}

function describeZodError(tool: string, error: z.ZodError): string {
  const problems = error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`);
  return `The ${tool} input was not usable (${problems.join("; ")}).`;
}
