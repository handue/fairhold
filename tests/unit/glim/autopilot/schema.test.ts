import { describe, expect, it } from "vitest";

import { DECISION_SCHEMA, decisionFromJson, decisionToJson, parseDecision } from "@/server/glim/autopilot/schema";

/** Keywords structured outputs cannot carry; the bounds live in the Zod parser instead. */
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

const GOLDEN_OUTPUT = {
  action: "change",
  lots: [
    { lot_number: 12, priority: 2, max_dollars: null },
    { lot_number: 9, priority: 3, max_dollars: null },
  ],
  raise_to_dollars: null,
  reason: "top_lot_out_of_reach",
  why: "The dinner is past your budget now, so your money goes to the wine tasting you hearted.",
};

describe("DECISION_SCHEMA", () => {
  it("is strict: closed objects with every property required, and no numeric bounds", () => {
    let objects = 0;
    walk(DECISION_SCHEMA, (node, path) => {
      for (const keyword of UNSUPPORTED) expect(node, path).not.toHaveProperty(keyword);
      if (node.type === "object") {
        objects += 1;
        expect(node.additionalProperties, path).toBe(false);
        expect([...(node.required as string[])].sort()).toEqual(Object.keys(node.properties as object).sort());
      }
    });
    expect(objects).toBe(2);
  });
});

describe("parseDecision", () => {
  it("reads the golden output into cents", () => {
    expect(parseDecision(JSON.stringify(GOLDEN_OUTPUT))).toEqual({
      ok: true,
      decision: {
        action: "change",
        lots: [
          { lotNumber: 12, priority: 2, maxCents: null },
          { lotNumber: 9, priority: 3, maxCents: null },
        ],
        raiseToCents: null,
        reason: "top_lot_out_of_reach",
        why: GOLDEN_OUTPUT.why,
      },
    });
  });

  it("round-trips through the shape the model writes", () => {
    const parsed = parseDecision(JSON.stringify({ ...GOLDEN_OUTPUT, lots: [{ lot_number: 12, priority: 1, max_dollars: 90 }] }));
    if (!parsed.ok) throw new Error(parsed.message);
    expect(decisionFromJson(decisionToJson(parsed.decision))).toEqual(parsed);
  });

  it("enforces the bounds the schema cannot", () => {
    const bad = (patch: Record<string, unknown>) => decisionFromJson({ ...GOLDEN_OUTPUT, ...patch }).ok;
    const lots = (entry: Record<string, unknown>) => ({ lots: [{ lot_number: 9, priority: 1, max_dollars: null, ...entry }] });
    expect(bad(lots({ priority: 0 }))).toBe(false);
    expect(bad(lots({ priority: 100 }))).toBe(false);
    expect(bad(lots({ lot_number: 0 }))).toBe(false);
    expect(bad(lots({ lot_number: 10_000 }))).toBe(false);
    expect(bad(lots({ max_dollars: 0 }))).toBe(false);
    expect(bad(lots({ max_dollars: 1_000_001 }))).toBe(false);
    expect(bad(lots({ max_dollars: 12.5 }))).toBe(false);
    expect(bad({ raise_to_dollars: 0 })).toBe(false);
    expect(bad({ why: "x".repeat(401) })).toBe(false);
    expect(bad({ lots: Array.from({ length: 13 }, (_, index) => ({ lot_number: index + 1, priority: 1, max_dollars: null })) })).toBe(false);
    expect(bad({ action: "bid" })).toBe(false);
    expect(bad({ reason: "because" })).toBe(false);
    expect(bad({ extra: true })).toBe(false);
  });

  it("rejects duplicate lots and anything that is not JSON", () => {
    expect(decisionFromJson({ ...GOLDEN_OUTPUT, lots: [GOLDEN_OUTPUT.lots[0], GOLDEN_OUTPUT.lots[0]] }).ok).toBe(false);
    expect(parseDecision("I'd move the money to the wine tasting.")).toEqual({ ok: false, message: "The reply was not JSON." });
    expect(parseDecision("").ok).toBe(false);
  });
});
