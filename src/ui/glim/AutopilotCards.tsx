import type { AutopilotCard, AutopilotRaiseCard } from "@/server/glim/autopilot/copy";

/**
 * The seam for Glim's own decisions (docs/planning/glim-autopilot.md §6.2, §11). The server stores
 * these cards, and they reach the panel with the rest of the chat, but they are not drawn until their
 * images are approved: V2 (the card, its rules footer and "Skip <lot>") and V3 (the prepared raise)
 * in design/21 and design/21b. Their buttons call skipLot and createHold through session-bound routes
 * that don't exist yet; those server functions are in src/server/plans and src/server/paypal.
 */
export function UndrawnAutopilotCard({ card }: { card: AutopilotCard | AutopilotRaiseCard }) {
  void card;
  return null;
}
