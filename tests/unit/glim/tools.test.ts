import { describe, expect, it } from "vitest";

import { GLIM_TOOL_CHOICE, GLIM_TOOLS, parseToolCall } from "@/server/glim/tools";

/** Keywords strict tool schemas cannot carry; bounds live in the Zod parsers instead. */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "maxItems"];

function walk(schema: unknown, visit: (node: Record<string, unknown>, path: string) => void, path = "$"): void {
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => walk(entry, visit, `${path}[${index}]`));
    return;
  }
  if (schema === null || typeof schema !== "object") return;
  const node = schema as Record<string, unknown>;
  visit(node, path);
  for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`);
}

describe("GLIM_TOOLS", () => {
  it("are the three proposal tools, all strict", () => {
    expect(GLIM_TOOLS.map((tool) => [tool.name, tool.strict])).toEqual([
      ["propose_plan", true],
      ["propose_change", true],
      ["suggest_hold_amount", true],
    ]);
  });

  it("use only schemas strict mode accepts: closed objects, every property required", () => {
    for (const tool of GLIM_TOOLS) {
      walk(tool.input_schema, (node, path) => {
        for (const keyword of UNSUPPORTED) expect(node, `${tool.name} ${path}`).not.toHaveProperty(keyword);
        if ("minItems" in node) expect([0, 1]).toContain(node.minItems);
        if (node.type === "object") {
          expect(node.additionalProperties, `${tool.name} ${path}`).toBe(false);
          expect(node.required).toEqual(Object.keys(node.properties as object));
        }
      });
    }
  });

  it("are chosen with auto, the only mode Opus 5.5 accepts, one per reply", () => {
    expect(GLIM_TOOL_CHOICE).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });
});

describe("parseToolCall", () => {
  it("turns a plan proposal into cents", () => {
    expect(
      parseToolCall("propose_plan", {
        budget_dollars: 500,
        items: [
          { lot_number: 7, priority: 1, cap_dollars: null },
          { lot_number: 12, priority: 2, cap_dollars: 120 },
        ],
      }),
    ).toEqual({
      ok: true,
      call: {
        kind: "plan",
        intent: {
          tool: "propose_plan",
          budgetCents: 50_000,
          items: [
            { lotNumber: 7, priority: 1, capCents: null },
            { lotNumber: 12, priority: 2, capCents: 12_000 },
          ],
        },
      },
    });
  });

  it("turns a hold suggestion into cents", () => {
    expect(parseToolCall("suggest_hold_amount", { amount_dollars: 1000, lot_numbers: [3] })).toEqual({
      ok: true,
      call: { kind: "hold", intent: { amountCents: 100_000, lotNumbers: [3] } },
    });
  });

  it("rejects inputs strict mode cannot rule out", () => {
    const zeroCap = parseToolCall("propose_change", {
      budget_dollars: 500,
      items: [{ lot_number: 7, priority: 1, cap_dollars: 0 }],
    });
    expect(zeroCap.ok).toBe(false);
    expect(parseToolCall("propose_plan", { budget_dollars: 500, items: [] }).ok).toBe(false);
    expect(parseToolCall("place_bid", { lot_number: 7 })).toEqual({
      ok: false,
      message: 'Glim has no tool named "place_bid".',
    });
  });
});
