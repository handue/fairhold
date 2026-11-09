/**
 * The deterministic rule (docs/planning/glim-autopilot.md §4.8): what Glim does when the model
 * may not or does not decide. It walks the guest's order and takes the first add that lowers no
 * live lot, else a top-up that lowers none, else keeps. It never lowers or drops a live lot,
 * never makes a priority call and never prepares a raise.
 */
import type { AutopilotOption } from "./options";
import { primaryTrigger, type AutopilotContext, type AutopilotDecision, type DecisionReason } from "./types";

export function ruleReason(context: Pick<AutopilotContext, "triggers">, option: AutopilotOption | null): DecisionReason {
  if (!option) return "nothing_fits";
  if (option.kind === "top_up") return "money_freed";
  switch (primaryTrigger(context.triggers)?.kind) {
    case "lot_won":
    case "hold_raised":
      return "money_freed";
    case "closing_soon":
      return "closing_soon";
    default:
      return "top_lot_out_of_reach";
  }
}

/** The option the rule takes, or null to keep. Options arrive in the guest's order. */
export function ruleOption(options: readonly AutopilotOption[]): AutopilotOption | null {
  return (
    options.find((option) => option.kind === "add" && !option.lowersLive) ??
    options.find((option) => option.kind === "top_up" && !option.lowersLive) ??
    null
  );
}

export function ruleDecision(context: Pick<AutopilotContext, "triggers">, options: readonly AutopilotOption[]): AutopilotDecision {
  const option = ruleOption(options);
  if (!option) return { action: "keep", lots: [], raiseToCents: null, reason: "nothing_fits", why: "" };
  return { action: "change", lots: option.lots, raiseToCents: null, reason: ruleReason(context, option), why: "" };
}
